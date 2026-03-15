# GhostCoach

Real-time AI gaming coach overlay powered by Claude — sits transparently on top of any game and gives you live tactical tips.

## Prerequisites

- **Node.js 18+** — [Download here](https://nodejs.org/en/download)
- An **Anthropic API key** — [Get one at console.anthropic.com](https://console.anthropic.com)

## Quick Start

```bash
# 1. Install dependencies
cd ghostcoach
npm install

# 2. Run the app
npm start
```

On first launch, you'll see a setup screen — paste your Anthropic API key and click **Launch GhostCoach**.

## Hotkeys

| Hotkey | Action |
|--------|--------|
| `Ctrl+Shift+C` | Toggle overlay visibility |
| `Ctrl+Shift+X` | Force immediate screenshot + analysis |

## Controls

- **Drag** the panel by its title bar to reposition it
- **▲/▼** collapses/expands the control panel
- **⚙** opens settings (capture interval)
- **⚡** forces an immediate capture
- **Game selector** switches between Valorant and League of Legends system prompts

## Supported Games

- **Valorant** — round economy, positioning, callout advice
- **League of Legends** — macro play, items, minimap, lane state

## Architecture

```
src/
├── main/
│   ├── index.js          # App entry point, coaching loop, IPC hub
│   ├── overlay.js        # BrowserWindow management (overlay + panel)
│   ├── capture.js        # Screen capture via hidden renderer window
│   ├── api.js            # Anthropic Claude API calls
│   ├── hotkeys.js        # Global shortcut registration
│   ├── store.js          # electron-store config persistence
│   ├── preload-overlay.js
│   ├── preload-panel.js
│   ├── preload-setup.js
│   └── preload-capture.js (handled via nodeIntegration)
└── renderer/
    ├── overlay/          # Transparent HUD tip display
    ├── panel/            # Draggable control panel
    ├── setup/            # First-run API key setup
    └── capture/          # Hidden window for desktopCapturer
```

## Notes

- The API key is stored locally via `electron-store` (not in `.env`)
- Rate limiting: minimum 5-second gap between API calls
- Model: `claude-haiku-4-5-20251001` (fast, cheap) — change to `claude-sonnet-4-20250514` in `src/main/api.js` when ready
- The overlay is fully click-through — your mouse clicks pass directly to the game
