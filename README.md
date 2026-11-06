# whatsapp-headless

Send WhatsApp messages and files from scripts, cron jobs and AI agents — **no browser, no window, nothing on screen**.

It links your account as an ordinary companion device (same protocol WhatsApp Web/Desktop use) with [Baileys](https://github.com/WhiskeySockets/Baileys), keeps the keys in a local folder, and exposes three ways to send:

| Surface | Use it for |
| --- | --- |
| CLI | one-off sends, cron jobs, shell scripts |
| Local HTTP API | any language / agent that can do a `POST` |
| MCP server (stdio) | Antigravity, Claude Desktop, Cursor, VS Code, Hermes, any MCP client |

Once paired, sending never opens a GUI — not even a hidden one. There is no Chromium, no Puppeteer, no CDP.

---

## Why not drive WhatsApp Web?

WhatWeb automation needs a visible/hidden Chrome, a cloned profile and cookies that Google/Meta now bind to the device (DBSC), so it breaks constantly and leaks a browser process per send. A linked device speaks the real protocol over a websocket: lighter, stable, and genuinely headless.

## Requirements

- Node.js 18+
- A phone with WhatsApp (to scan one QR code)

## Install

```bash
git clone https://github.com/<you>/whatsapp-headless.git
cd whatsapp-headless
npm install
```

## Pair once

```bash
npm run login
```

A QR appears in the terminal (and as `auth/qr.png`). On the phone:
**WhatsApp → Settings → Linked devices → Link a device** → scan.

The session is stored in `auth/` (`WA_AUTH_DIR` to change it). Treat that folder as a password: anyone with it can send as that account. It is git-ignored.

## Send

```bash
# text to yourself
node src/cli.js send me --text "backup finished"

# any file to yourself (images/videos/audio go inline, the rest as a document)
node src/cli.js send me --file ./report.pdf --caption "monthly report"

# to someone else: any phone format works
node src/cli.js send "+55 11 91234-5678" --file ./invoice.pdf

# group by jid
node src/cli.js send "120363000000000000@g.us" --text "deploy done"

# force document mode (no inline preview for images)
node src/cli.js send me --file ./shot.png --document
```

`status` shows pairing and connection state, `logout` wipes the local session.

## Local HTTP API

```bash
WA_PORT=8787 WA_TOKEN=optional-secret npm run serve
```

Open **http://127.0.0.1:8787/** for the pairing page: it shows the QR, **renews it automatically** (Baileys rotates the code every ~20 s), flips to "paired" as soon as the phone confirms, and has a send box for quick tests.

```bash
curl -s localhost:8787/health
curl -s localhost:8787/qr -o qr.png                     # only while unpaired

curl -s -X POST localhost:8787/send \
  -H 'content-type: application/json' \
  -H "x-api-key: $WA_TOKEN" \
  -d '{"to":"me","file":"C:/path/report.pdf","caption":"done"}'
```

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/` , `/pair` | pairing page with self-renewing QR |
| GET | `/events` | Server-Sent Events stream: state pushed the instant it changes |
| GET | `/health` | pairing, connection, jid |
| GET | `/qr` , `/qr.png` | PNG of the pairing QR (`?format=text` for the raw string) |
| GET | `/status/<id>` | delivery receipt of a message id returned by `/send` |
| GET | `/status` | status panel: service, WhatsApp, browser sessions, API keys |
| GET | `/api/service` | pid, uptime, version, auth dir, last sends |
| GET | `/api/keys/status` | platforms with an active login (`?refresh=1` bypasses the 2 min cache) |
| GET/POST | `/api/keys/scan` | `POST` starts a key scan, `GET` polls it (masked values only) |
| POST | `/send` | `{ "to", "text", "file", "caption", "filename", "asDocument" }` |

### Pairing detection

The page never guesses: `/events` pushes `phase` transitions.

| `phase` | meaning | page shows |
| --- | --- | --- |
| `pairing` | waiting for the scan, a fresh QR is on screen | QR + instructions |
| `connecting` with `scanned: true` | phone approved the code, session syncing | **"Carregando…"** |
| `open` | ready, `jid` filled in | paired ✓ |

Because it is a push stream, the switch to "loading" happens in the same instant the phone confirms — no polling interval to wait for. If `EventSource` is unavailable the page falls back to `/health` polling on its own.

The server binds `127.0.0.1` by default (`WA_HOST`, `WA_PORT`) and reconnects on its own.

## Status panel and desktop shortcut

`/status` keeps everything an operator needs on a single page: WhatsApp pairing state (live over
`/events`, with the QR inline while it is not paired), service pid / uptime / version, the last
sends with their delivery receipt, the platforms that still hold a logged-in session, and the API
keys found inside that session — always masked.

```powershell
# Windows: puts "Status do WhatsApp" on the Desktop
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1
```

The shortcut runs `desktop/status.vbs`, which

1. checks whether `127.0.0.1:8787` already answers,
2. if not, starts `node src/server.js` **without any window** and waits up to 30 s for it,
3. opens the panel in the default browser.

One double click is enough to bring the service back after a reboot. The hidden start logs to
`%LOCALAPPDATA%\whatsapp-headless.log`. Uninstall = delete the shortcut (and the project folder).

The right-hand side of the panel is optional and reads from a separate local tool of your own,
configured in `config.local.json` (git-ignored):

```json
{ "csDir": "C:/path/to/your-session-tool" }
```

That folder must be a Python project exposing `status` and `scan` subcommands that print JSON
(module defaults to `chromesession.cli`; override with `CS_DIR`, `CS_PYTHON` or `csModule`).
Without it the card says "não configurado" and the rest keeps working. A scan takes ~2 minutes, so
it runs on demand, in the background, with the page polling for the result.

## MCP server (Antigravity, Claude Desktop, Cursor, ...)

Add to the client's MCP config:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["C:/path/to/whatsapp-headless/src/mcp.js"],
      "env": { "WA_AUTH_DIR": "C:/path/to/whatsapp-headless/auth" }
    }
  }
}
```

Tools exposed: `wa_status`, `wa_send_text`, `wa_send_file`, `wa_pair`.

`wa_send_file` example arguments: `{ "to": "me", "file": "C:/tmp/report.pdf", "caption": "done" }`.

## How it works

- `src/client.js` — socket, auth state, jid resolution, media kind detection by MIME.
- `src/cli.js` — terminal surface.
- `src/server.js` — HTTP surface, single long-lived socket, auto-reconnect.
- `src/status.html` — status panel (service, WhatsApp, sessions, keys).
- `src/keys.js` — optional bridge to an external session/key tool; masks every secret.
- `desktop/status.vbs` + `desktop/install-shortcut.ps1` — desktop shortcut and hidden cold start.
- `src/mcp.js` — MCP stdio JSON-RPC 2.0 (no SDK dependency).

`to` accepts `me`/`self`, any phone format (`+55 11 9...`, `5511...`), or a full jid (`...@s.whatsapp.net`, `...@g.us`).

## Caveats

- `@whiskeysockets/baileys` is currently published as `7.0.0-rc.x`; pin it if you need stability.
- This is an unofficial client. WhatsApp's Terms forbid unofficial clients and automated bulk messaging; accounts can be limited or banned. Use it on your own account, for your own automation, at human-ish rates.
- One device slot is used (WhatsApp allows 4‑5 linked devices).
- Sending to a number that is not on WhatsApp fails — catch the error.

## Português

Envia mensagens e arquivos pelo WhatsApp **sem navegador e sem janela nenhuma**: pareia uma vez pelo QR (`npm run login`) e depois use CLI, API HTTP local ou o servidor MCP. A sessão fica em `auth/` (trate como senha, já está no `.gitignore`). `to: "me"` manda para você mesmo.

## License

MIT — see [LICENSE](LICENSE).
