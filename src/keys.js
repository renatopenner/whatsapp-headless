'use strict';
/**
 * Bridge to the optional "browser session / API keys" tool (a separate Python
 * project). Used only by the status panel: the sender itself never needs it.
 *
 * Configure it in `config.local.json` (git-ignored) or with env vars:
 *   { "csDir": "C:/path/to/ChromeSessionAPI" }
 *   CS_DIR / CS_PYTHON
 *
 * Everything here is read-only: it runs the tool's own `status` / `scan`
 * commands and masks every secret before it reaches the browser.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.local.json');

function config() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { /* optional */ }
  const dir = cfg.csDir || process.env.CS_DIR || '';
  const fallback = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const py = cfg.csPython || process.env.CS_PYTHON || (dir ? path.join(dir, fallback) : '');
  const ready = !!dir && !!py && fs.existsSync(py) && fs.existsSync(dir);
  return { dir, py, ready, module: cfg.csModule || 'chromesession.cli' };
}

function runJson(args, timeoutMs) {
  const { dir, py, module } = config();
  return new Promise((resolve, reject) => {
    if (!dir) return reject(new Error('ferramenta de chaves nao configurada (config.local.json: csDir)'));
    const child = spawn(py, ['-m', module, ...args], { cwd: dir, windowsHide: true });
    let out = '';
    let err = '';
    const kill = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error(`timeout ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(kill); reject(e); });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code !== 0 && !out.trim()) return reject(new Error((err || `exit ${code}`).trim().slice(0, 400)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('saida invalida: ' + out.slice(0, 200))); }
    });
  });
}

/** Never let a real secret reach the page. */
function mask(value) {
  const v = String(value || '');
  if (v.length <= 12) return '••••';
  return `${v.slice(0, 6)}…${v.slice(-4)} (${v.length})`;
}

const state = {
  status: { ranAt: null, data: null, error: null, running: false },
  scan: { ranAt: null, data: null, error: null, running: false, startedAt: null },
};

async function getStatus({ force } = {}) {
  const fresh = state.status.ranAt && Date.now() - state.status.ranAt < 120000;
  if (!force && fresh) return state.status;
  if (state.status.running) return state.status;
  state.status.running = true;
  try {
    const data = await runJson(['status'], 45000);
    state.status = {
      ranAt: Date.now(), running: false, error: null,
      data: (Array.isArray(data) ? data : []).map((p) => ({
        platform: p.platform, label: p.label || p.platform,
        logged_in: !!p.logged_in, notes: p.notes || '',
        keys: Array.isArray(p.key_cookies_present) ? p.key_cookies_present : [],
      })),
    };
  } catch (e) {
    state.status = { ranAt: Date.now(), running: false, data: null, error: e.message };
  }
  return state.status;
}

function startScan() {
  if (state.scan.running || !config().ready) return state.scan;
  state.scan = { ranAt: null, data: null, error: null, running: true, startedAt: Date.now() };
  runJson(['scan'], 300000)
    .then((data) => {
      const findings = (data && data.findings ? data.findings : []).map((f) => ({
        kind: f.kind, key: f.key || '', where: f.where || '', origin: f.origin || '',
        preview: mask(f.value), length: String(f.value || '').length,
      }));
      const kinds = {};
      for (const f of findings) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
      state.scan = {
        ranAt: Date.now(), running: false, error: null, startedAt: null,
        data: { profile: (data && data.profile) || '', count: findings.length, kinds, findings },
      };
    })
    .catch((e) => {
      state.scan = { ranAt: Date.now(), running: false, startedAt: null, data: null, error: e.message };
    });
  return state.scan;
}

function scanState() {
  return state.scan;
}

module.exports = { config, getStatus, startScan, scanState, mask, state };
