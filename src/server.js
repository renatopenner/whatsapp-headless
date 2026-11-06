'use strict';
/**
 * Local HTTP API so any agent (or script) can send WhatsApp messages/files
 * without a window and without touching a browser.
 *
 *   node src/server.js            listens on 127.0.0.1:8787
 *   WA_PORT=9000 WA_TOKEN=secret node src/server.js
 *
 * Endpoints
 *   GET  /                    pairing page (self-renewing QR + live status)
 *   GET  /events              server-sent events: instant state changes
 *   GET  /health              pairing + connection state (snapshot)
 *   GET  /qr, /qr.png         PNG of the pairing QR (only while unpaired)
 *   POST /send {to,text,file} send text and/or a file
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

// phase: starting -> pairing (QR on screen) -> connecting (scan accepted, syncing) -> open
const state = { session: null, qr: null, lastError: null, phase: 'starting', scanned: false };

/** Clients connected to /events; every change is pushed to them immediately. */
const subscribers = new Set();

// Delivery receipts, so a caller can prove a send really landed.
// 1 pending, 2 server ack, 3 delivered, 4 read, 5 played.
const ACK = { 0: 'error', 1: 'pending', 2: 'server_ack', 3: 'delivery_ack', 4: 'read', 5: 'played' };
const acks = new Map();
const tracked = new WeakSet();

function trackSock(sock) {
  if (!sock || !sock.ev || tracked.has(sock)) return;
  tracked.add(sock);

  const bump = (id, status) => {
    if (!id || !status) return false;
    acks.set(id, status);
    return true;
  };

  sock.ev.on('messages.update', (updates) => {
    let changed = false;
    for (const u of updates) {
      const st = u.update && u.update.status;
      if (st === undefined || st === null) continue;
      changed = bump(u.key && u.key.id, ACK[st] || String(st)) || changed;
    }
    if (changed) broadcast();
  });

  // Receipts for our own outgoing messages arrive here, not in messages.update.
  sock.ev.on('message-receipt.update', (updates) => {
    let changed = false;
    for (const u of updates) {
      const r = u.receipt || {};
      const status = r.readTimestamp ? 'read' : r.receiptTimestamp ? 'delivery_ack' : 'pending';
      changed = bump(u.key && u.key.id, status) || changed;
    }
    if (changed) broadcast();
  });

  if (process.env.WA_DEBUG) {
    sock.ev.process((events) => {
      try { console.error('[ev]', Object.keys(events).join(',')); } catch { /* ignore */ }
    });
  }
}

function snapshot() {
  return {
    ok: true,
    phase: state.phase,
    paired: isPaired(),
    connected: !!(state.session && state.session.open),
    // scan accepted, session still syncing -> UI should say "loading"
    loading: state.phase === 'connecting' && state.scanned,
    jid: state.session ? state.session.jid : null,
    needs_pairing: state.phase === 'pairing',
    auth_dir: authDir(),
    last_error: state.lastError,
    ts: Date.now(),
  };
}

function broadcast() {
  const frame = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of subscribers) {
    try { res.write(frame); } catch { subscribers.delete(res); }
  }
}

async function boot() {
  try {
    const session = await connect({
      onQR: (qr) => { state.qr = qr; },
      onUpdate: (info) => {
        state.phase = info.phase;
        if (info.session) state.session = info.session;
        state.scanned = !!info.scanned;
        if (info.session) trackSock(info.session.sock);
        if (info.phase === 'open') {
          state.qr = null;
          state.lastError = null;
        }
        broadcast();
      },
    });
    state.session = session;
    await session.ready;
    state.qr = null;
    state.lastError = null;
    broadcast();
  } catch (e) {
    state.lastError = e.message;
    state.phase = 'error';
    broadcast();
  }
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function authed(req, query) {
  if (!TOKEN) return true;
  if (query && query.token === TOKEN) return true;
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
  if (!authed(req, query)) return json(res, 401, { ok: false, error: 'unauthorized' });

  try {
    // Pairing page: shows the QR, renews it automatically, and confirms pairing.
    if (req.method === 'GET' && (pathname === '/' || pathname === '/pair')) {
      const html = fs.readFileSync(path.join(__dirname, 'pair.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store' });
      return res.end(html);
    }

    // Live feed: the page knows the instant the phone scans, without polling lag.
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      subscribers.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* closed */ }
      }, 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        subscribers.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, snapshot());
    }

    if (req.method === 'GET' && (pathname === '/qr' || pathname === '/qr.png')) {
      if (!state.qr) return json(res, 409, { ok: false, error: 'no pairing in progress (already paired?)' });
      if (query.format === 'text') return json(res, 200, { ok: true, qr: state.qr });
      const png = await QRCode.toBuffer(state.qr, { width: 512, margin: 2 });
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store' });
      return res.end(png);
    }

    if (req.method === 'GET' && pathname === '/me') {
      return json(res, 200, { ok: true, jid: state.session ? state.session.jid : null });
    }

    // Delivery status of a message id returned by /send
    if (req.method === 'GET' && (pathname === '/status' || pathname.startsWith('/status/'))) {
      const id = pathname.startsWith('/status/') ? decodeURIComponent(pathname.slice(8)) : query.id;
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      return json(res, 200, { ok: true, id, status: acks.get(id) || 'unknown' });
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
