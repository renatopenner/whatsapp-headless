'use strict';
/**
 * Local HTTP API so any agent (or script) can send WhatsApp messages/files
 * without a window and without touching a browser.
 *
 *   node src/server.js            listens on 127.0.0.1:8787
 *   WA_PORT=9000 WA_TOKEN=secret node src/server.js
 *
 * Endpoints
 *   GET  /health                      -> pairing + connection state
 *   GET  /qr                          -> PNG of the pairing QR (only while unpaired)
 *   POST /send  {to,text,file,caption}-> send text and/or a file
 *
 * `to` accepts "me", a phone number in any format, or a full jid
 * (e.g. 1234567890-123456@g.us for a group).
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { connect, isPaired, sendText, sendFile, authDir } = require('./client');

const PORT = Number(process.env.WA_PORT || 8787);
const HOST = process.env.WA_HOST || '127.0.0.1';
const TOKEN = process.env.WA_TOKEN || '';

const state = { session: null, qr: null, lastError: null };

async function boot() {
  try {
    state.session = await connect({
      onQR: (qr) => { state.qr = qr; },
    });
    await state.session.ready;
    state.qr = null;
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
  }
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function authed(req) {
  if (!TOKEN) return true;
  return req.headers['x-api-key'] === TOKEN || (req.headers.authorization || '') === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e7) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

  try {
    // Pairing page: shows the QR, renews it automatically, and confirms pairing.
    if (req.method === 'GET' && (pathname === '/' || pathname === '/pair')) {
      const html = fs.readFileSync(path.join(__dirname, 'pair.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, {
        ok: true,
        paired: isPaired(),
        connected: !!(state.session && state.session.open),
        jid: state.session ? state.session.jid : null,
        needs_pairing: !!state.qr,
        auth_dir: authDir(),
        last_error: state.lastError,
      });
    }

    if (req.method === 'GET' && (pathname === '/qr' || pathname === '/qr.png')) {
      if (!state.qr) return json(res, 409, { ok: false, error: 'no pairing in progress (already paired?)' });
      if (query.format === 'text') return json(res, 200, { ok: true, qr: state.qr });
      const png = await QRCode.toBuffer(state.qr, { width: 512, margin: 2 });
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return res.end(png);
    }

    if (req.method === 'GET' && pathname === '/me') {
      return json(res, 200, { ok: true, jid: state.session ? state.session.jid : null });
    }

    if (req.method === 'POST' && pathname === '/send') {
      const body = await readBody(req);
      if (!state.session || !state.session.open) return json(res, 503, { ok: false, error: 'not connected' });
      const to = body.to || 'me';
      const sent = [];
      if (body.file) {
        const abs = path.isAbsolute(body.file) ? body.file : path.resolve(process.cwd(), body.file);
        if (!fs.existsSync(abs)) return json(res, 400, { ok: false, error: `file not found: ${abs}` });
        sent.push(await sendFile(state.session.sock, to, abs, {
          caption: body.caption, filename: body.filename, asDocument: !!body.asDocument,
        }));
      }
      if (body.text) sent.push(await sendText(state.session.sock, to, body.text));
      if (!sent.length) return json(res, 400, { ok: false, error: 'nothing to send' });
      return json(res, 200, { ok: true, sent });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ok: true, listening: `http://${HOST}:${PORT}`, auth_dir: authDir() }));
  boot();
});
