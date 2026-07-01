# GhostCoach

Real-time **Valorant** AI coaching overlay. GhostCoach sits on top of the game in
borderless-windowed mode, periodically captures the screen, sends it to the
GhostCoach server for AI analysis, and shows concise coaching tips on a
glassmorphism HUD. Players unlock the app with a license key.

> This repository is the **Electron desktop client**. The AI/vision/licensing
> backend is a separate service at `https://ghostcoach-production.up.railway.app`.

## Quick start

```bash
npm install
npm start          # or: npm run dev
```

On first launch you'll see the **activation screen** — paste your license key.
After that, GhostCoach launches straight to the overlay + control panel.

## Hotkeys

| Hotkey | Action |
|--------|--------|
| `Ctrl+Shift+C` | Toggle overlay visibility |
| `Ctrl+Shift+X` | Force an immediate tip |
| `Ctrl+Shift+P` | Pause / resume coaching |
| `Ctrl+Shift+S` | Open settings |

## Architecture

```
src/
├─ shared/
│  ├─ channels.js          # single source of truth for all IPC channel names
│  └─ config.js            # server URL, timings, brand, store defaults
├─ main/
│  ├─ index.js             # app lifecycle, coaching controller, event→IPC fan-out
│  ├─ logger.js            # tees console + renderer consoles → debug.log
│  ├─ tray.js · hotkeys.js
│  ├─ windows/             # overlay · panel · settings · activation (+ registry)
│  ├─ ipc/register-ipc.js  # every ipcMain handler, one place
│  └─ services/
│     ├─ api-client.js     # POST + X-License-Key + timeout
│     ├─ license-service.js
│     ├─ coaching-engine.js# capture→analyze loop + tip guardrails
│     ├─ tip-library.js    # situation-aware offline fallback tips
│     ├─ capture.js        # worker-thread manager
│     └─ capture-worker.js # PowerShell screen capture (Worker Thread)
├─ preload/                # one contextIsolated bridge per window
└─ renderer/               # overlay · panel · settings · activation + shared CSS
```

**Key design points**

- **Single-source-of-truth IPC** — main and every preload import `shared/channels.js`,
  so channel names can never drift out of sync.
- **`contextIsolation: true`, `nodeIntegration: false`** on every window; preloads
  expose a minimal `window.ghost` API. Renderer consoles are teed into `debug.log`
  so a broken bridge can never fail silently.
- **Capture runs in a Worker Thread** (PowerShell `Graphics.CopyFromScreen`) so the
  game never stalls on a screenshot.
- **License-based** — no API keys. The client only talks to the GhostCoach backend.

## Build (Windows)

```bash
npm run dist:win        # NSIS installer in dist/
```

## Notes

- Config + license cache live in `electron-store` under `%APPDATA%\ghostcoach\`.
- A session log is written to `%APPDATA%\ghostcoach\debug.log` (truncated each run).
- If Windows Defender ever flags the screen-capture step, add a folder exclusion for
  the install directory (screen capture is a normal `.NET` API but can trip heuristics).
