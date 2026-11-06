#!/usr/bin/env node
'use strict';
/**
 * CLI for the headless WhatsApp bridge.
 *
 *   node src/cli.js login                 pair a device (prints a QR, also saves a PNG)
 *   node src/cli.js status                show pairing/connection state
 *   node src/cli.js send me --text "hi"   message yourself
 *   node src/cli.js send me --file a.pdf  send a file to yourself
 *   node src/cli.js logout                unlink this device locally
 *
 * Everything after pairing runs without any window: no browser, no GUI.
 */

const fs = require('fs');
const path = require('path');
const { connect, isPaired, sendText, sendFile, authDir } = require('./client');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) out[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function printQR(qr) {
  const qrcodeTerminal = require('qrcode-terminal');
  qrcodeTerminal.generate(qr, { small: true });
  const QRCode = require('qrcode');
  const file = path.join(authDir(), 'qr.png');
  await QRCode.toFile(file, qr, { width: 512, margin: 2 });
  return file;
}

async function cmdLogin(args) {
  let qrFile = null;
  const session = await connect({
    onQR: async (qr) => {
      qrFile = await printQR(qr).catch(() => null);
    },
  });
  await session.ready;
  console.log(JSON.stringify({ ok: true, paired: true, jid: session.jid, qr_png: qrFile }, null, 2));
  // keep the socket alive briefly so the server-side session settles
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}

async function cmdStatus() {
  const out = { paired: isPaired(), auth_dir: authDir(), connected: false, jid: null };
  if (out.paired) {
    const session = await connect({ reconnect: false });
    try {
      await Promise.race([session.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))]);
      out.connected = true;
      out.jid = session.jid;
    } catch (e) {
      out.error = e.message;
    }
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

async function cmdSend(args) {
  const [to] = args._;
  if (!to) throw new Error('usage: send <me|number|jid> (--text ... | --file ...) [--caption ...]');
  if (!args.text && !args.file) throw new Error('give --text or --file');

  const session = await connect({ reconnect: false });
  await Promise.race([session.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 60000))]);

  const results = [];
  if (args.file) {
    results.push(await sendFile(session.sock, to, args.file, {
      caption: args.caption,
      filename: args.filename,
      asDocument: !!args.document,
    }));
  }
  if (args.text) results.push(await sendText(session.sock, to, args.text));

  console.log(JSON.stringify({ ok: true, sent: results }, null, 2));
  await new Promise((r) => setTimeout(r, 1200));
  process.exit(0);
}

function cmdLogout() {
  const dir = authDir();
  for (const f of fs.readdirSync(dir)) {
    if (f === 'qr.png') continue;
    fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  }
  console.log(JSON.stringify({ ok: true, cleared: dir }, null, 2));
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  try {
    if (cmd === 'login') await cmdLogin(args);
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'send') await cmdSend(args);
    else if (cmd === 'logout') cmdLogout();
    else {
      console.log('commands: login | status | send <to> [--text|--file] [--caption] | logout');
      process.exit(1);
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exit(1);
  }
})();
