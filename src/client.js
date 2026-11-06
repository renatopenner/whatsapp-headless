'use strict';
/**
 * Headless WhatsApp client (multi-device link, no browser, no window).
 *
 * Uses Baileys, which speaks the same linked-device protocol as WhatsApp Web /
 * Desktop, but runs entirely in Node. Once the device is paired (one QR scan),
 * sending messages and files needs no GUI at all.
 */

const fs = require('fs');
const path = require('path');
const P = require('pino');

const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.makeWASocket || baileys.default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = baileys;

const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, '..', 'auth');
const QUIET = process.env.WA_DEBUG ? 'debug' : 'silent';

const log = P({ level: QUIET }, P.destination({ dest: 2, sync: false }));

function authDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  return AUTH_DIR;
}

function isPaired() {
  try {
    return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
  } catch {
    return false;
  }
}

/** "me", "self", "+55 91 99999-9999", "5511999999999", "123@g.us" -> jid */
function resolveJid(sock, to) {
  const raw = String(to || '').trim();
  if (!raw || raw === 'me' || raw === 'self') {
    if (!sock || !sock.user) throw new Error('not connected yet: cannot resolve "me"');
    return jidNormalizedUser(sock.user.id);
  }
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) throw new Error(`invalid destination: ${to}`);
  return `${digits}@s.whatsapp.net`;
}

const KIND = {
  image: /^image\//,
  video: /^video\//,
  audio: /^audio\//,
  sticker: /^image\/webp$/,
};

function detectKind(mimetype) {
  if (KIND.image.test(mimetype)) return 'image';
  if (KIND.video.test(mimetype)) return 'video';
  if (KIND.audio.test(mimetype)) return 'audio';
  if (KIND.sticker.test(mimetype)) return 'sticker';
  return 'document';
}

/**
 * Connect and keep reconnecting. Resolves once the socket is open.
 * onQR(text) is called with the raw pairing string whenever pairing is needed.
 */
async function connect({ onQR, reconnect = true } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir());
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: log,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: baileys.Browsers && baileys.Browsers.macOS ? baileys.Browsers.macOS('Desktop') : undefined,
  });

  const session = { sock, jid: null, qr: null, closed: false, open: false };

  const opened = new Promise((resolve, reject) => {
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        session.qr = qr;
        if (onQR) {
          try { onQR(qr); } catch { /* caller's problem */ }
        }
      }
      if (connection === 'open') {
        session.open = true;
        session.qr = null;
        session.jid = jidNormalizedUser(sock.user.id);
        resolve(session);
      }
      if (connection === 'close') {
        session.open = false;
        session.closed = true;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : undefined;
        if (code === DisconnectReason.loggedOut) {
          reject(new Error('device logged out: delete the auth folder and pair again'));
          return;
        }
        if (!reconnect) { reject(new Error(`connection closed (code ${code})`)); return; }
        setTimeout(() => connect({ onQR, reconnect }).catch(() => {}), 2000);
      }
    });
  });

  session.ready = opened;
  return session;
}

async function sendText(sock, to, text) {
  if (!text) throw new Error('empty text');
  const jid = resolveJid(sock, to);
  const res = await sock.sendMessage(jid, { text: String(text) });
  return { to: jid, id: res && res.key ? res.key.id : null };
}

async function sendFile(sock, to, filePath, { caption, filename, asDocument } = {}) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const stat = fs.statSync(abs);
  if (!stat.size) throw new Error(`file is empty: ${abs}`);

  const mime = require('mime-types');
  const mimetype = mime.lookup(abs) || 'application/octet-stream';
  const kind = asDocument ? 'document' : detectKind(mimetype);
  const buffer = fs.readFileSync(abs);
  const name = filename || path.basename(abs);
  const jid = resolveJid(sock, to);

  let payload;
  if (kind === 'image') payload = { image: buffer, mimetype, caption };
  else if (kind === 'video') payload = { video: buffer, mimetype, caption };
  else if (kind === 'audio') payload = { audio: buffer, mimetype, ptt: false };
  else {
    payload = {
      document: buffer,
      mimetype,
      fileName: name,
      caption,
    };
  }

  const res = await sock.sendMessage(jid, payload);
  return { to: jid, kind, bytes: stat.size, mimetype, fileName: name, id: res && res.key ? res.key.id : null };
}

module.exports = { connect, isPaired, resolveJid, sendText, sendFile, authDir, detectKind, AUTH_DIR };
