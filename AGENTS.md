# AGENTS.md

## Cursor Cloud specific instructions

GhostCoach is two services in one repo:
- Electron desktop client at the repo root (`src/`, `native/`). See `README.md`.
- Express backend API in `server/`. See `server/README.md`.

The Cursor Cloud VM is Linux, but GhostCoach is a Windows-first product. Keep these non-obvious caveats in mind.

### Backend (`server/`)
- Run with `npm start` (or `npm run dev` for nodemon reload) from `server/`; listens on `PORT` (default `3001`).
- The server needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` set at boot or it crashes immediately — `@supabase/supabase-js` `createClient()` throws `supabaseUrl is required.` at module load (caught by the crash guard, so `listen()` never runs). A `server/.env` (gitignored) with placeholder Supabase values is enough to boot; `/health`, `/api/health`, and license input-validation (format/required-field checks) work without real credentials.
- Real license lookups and the `/api/coach/*` endpoints need real Supabase creds plus an AI key (`AI_API_KEY` for OpenRouter/Qwen, or `GEMINI_API_KEY`). Stats endpoints also need `HENRIKDEV_API_KEY`. Without these, those routes return errors or hang (routes lack try/catch around Supabase calls). Add missing keys as Secrets.
- Mint a test license (needs real Supabase): `node server/create-test-key.js` inserts an active `GC-XXXX-...` key.

### Electron client (root)
- On this Linux desktop (`DISPLAY=:1`), launch with GPU disabled or Electron dies with `GPU process isn't usable. Goodbye.`:
  `DISPLAY=:1 LIBGL_ALWAYS_SOFTWARE=1 ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage`
  (dbus "Failed to connect to the bus" warnings are harmless.)
- `SERVER_BASE_URL` is hardcoded to the production Railway backend in `src/shared/config.js` (marked "do not change"). So the activation screen does a real round-trip to production; a well-formed but unknown key returns `License key not found`.
- Screen capture uses the Windows-only `native/GhostCoachCapture.exe` (PowerShell/.NET). On Linux it fails with `EACCES`/spawn errors — this is expected and handled gracefully (the engine emits a fallback "Windows blocked screen capture" tip). The full capture→AI→tip loop cannot run on this VM.
- Dev self-test env flags (in `src/main/index.js`) for exercising the UI without Windows/a real license:
  - `GHOST_DEV_AUTOLAUNCH=1` bypasses licensing, launches the app, and starts coaching.
  - `GHOST_DEV_FAKE_MIX=1` injects sample AI/library tips so the overlay renders tip cards.
  - `GHOST_DEV_NOQUIT=1` keeps it running (otherwise the self-test quits after ~4s).
  - `GHOST_DEV_ACTIVATE_KEY=<key>` drives the real activation path from the CLI.
- License watchdog: without a locally-valid cached license, the panel flips to "Subscription ended" ~60s after launch and coaching stops. For a stable dev/demo session, seed a cached license in the electron-store config (`~/.config/GhostCoach 2.0/ghostcoach-config.json`: set `licenseKey`, `licenseStatus:"active"`, a future `licenseExpiry`) or rely on the `GHOST_DEV_*` flags.
- Overlay tip cards auto-dismiss after 11s (`TIP_TTL` in `src/renderer/overlay/overlay.js`); the control panel keeps a persistent last-tip + tip count. Force-tip hotkey is `Ctrl+Shift+X` (the onboarding card's "Ctrl+Shift+T" text is stale; `src/main/hotkeys.js` is authoritative).

### Lint / test / build
- There is no lint or automated-test tooling in either `package.json` (no `test`/`lint` scripts). Validate changes by running the services.
- Client packaging targets Windows/macOS (`npm run dist:win` / `dist:mac`); these are not runnable on the Linux VM.
