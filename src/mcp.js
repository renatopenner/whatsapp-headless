#!/usr/bin/env node
'use strict';
/**
 * MCP server (stdio, JSON-RPC 2.0, protocol 2024-11-05) exposing the headless
 * WhatsApp bridge to any MCP client: Claude Desktop, Antigravity, Cursor,
 * VS Code, Hermes, ...
 *
 * Register it like this (adapt paths):
 *
 *   {
 *     "mcpServers": {
 *       "whatsapp": {
 *         "command": "node",
 *         "args": ["C:/path/to/whatsapp-headless/src/mcp.js"],
 *         "env": { "WA_AUTH_DIR": "C:/path/to/whatsapp-headless/auth" }
 *       }
 *     }
 *   }
 *
 * Tools: wa_status, wa_send_text, wa_send_file, wa_pair
 */

const path = require('path');
const QRCode = require('qrcode');
const { connect, isPaired, sendText, sendFile, authDir } = require('./client');

const PROTOCOL = '2024-11-05';
const NAME = 'whatsapp-headless';
const VERSION = require('../package.json').version;

const TOOLS = [
  {
    name: 'wa_status',
    description: 'Check whether the WhatsApp device is paired and connected. Returns the account jid.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wa_send_text',
    description: 'Send a WhatsApp text message. Use to="me" to message yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '"me" for your own chat, a phone number, or a full jid (group: ...@g.us)' },
        text: { type: 'string', description: 'Message body' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'wa_send_file',
    description: 'Send a file from disk to a WhatsApp chat. Images/videos/audio are sent inline, everything else as a document.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '"me", phone number, or full jid' },
        file: { type: 'string', description: 'Absolute path to the file (forward slashes are fine on Windows)' },
        caption: { type: 'string', description: 'Optional caption' },
        filename: { type: 'string', description: 'Optional display name override' },
        asDocument: { type: 'boolean', description: 'Force document mode (no inline preview)' },
      },
      required: ['to', 'file'],
      additionalProperties: false,
    },
  },
  {
    name: 'wa_pair',
    description: 'Start device pairing. Returns a QR image path (and the raw string) to scan with WhatsApp > Linked devices.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const state = { session: null, qr: null };

async function ensureSession() {
  if (state.session && state.session.open) return state.session;
  state.session = await connect({ onQR: (qr) => { state.qr = qr; } });
  await Promise.race([
    state.session.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout (still unpaired? run wa_pair)')), 60000)),
  ]);
  state.qr = null;
  return state.session;
}

async function callTool(name, args) {
  if (name === 'wa_status') {
    return {
      paired: isPaired(),
      connected: !!(state.session && state.session.open),
      jid: state.session ? state.session.jid : null,
      auth_dir: authDir(),
    };
  }
  if (name === 'wa_pair') {
    if (isPaired()) return { paired: true, note: 'already paired; run wa_status' };
    state.session = await connect({ onQR: (qr) => { state.qr = qr; } });
    const deadline = Date.now() + 25000;
    while (!state.qr && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (!state.qr) return { paired: false, error: 'no QR produced — check network' };
    const file = path.join(authDir(), 'qr.png');
    await QRCode.toFile(file, state.qr, { width: 512, margin: 2 });
    return { paired: false, qr_png: file, qr: state.qr, hint: 'WhatsApp > Linked devices > Link a device' };
  }
  if (name === 'wa_send_text') {
    const s = await ensureSession();
    return await sendText(s.sock, args.to, args.text);
  }
  if (name === 'wa_send_file') {
    const s = await ensureSession();
    return await sendFile(s.sock, args.to, args.file, {
      caption: args.caption, filename: args.filename, asDocument: args.asDocument,
    });
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(req) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });
    }
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      const out = await callTool(name, (params && params.arguments) || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return reply(id, {});
    if (method && method.startsWith('notifications/')) return;
    return fail(id, -32601, `method not found: ${method}`);
  } catch (e) {
    return fail(id, -32000, e.message);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});
