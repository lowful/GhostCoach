// Main-process overlay window management.
// Overlay is FULLY non-interactive — always click-through.
// All controls live in the separate settings window.

const { BrowserWindow, screen, Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs   = require('fs');

let overlayWindow = null;
let tray = null;
let overlayVisible = true;

function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;

  overlayWindow = new BrowserWindow({
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    width,
    height,
    transparent:  true,
    frame:        false,
    alwaysOnTop:  true,
    skipTaskbar:  true,
    resizable:    false,
    focusable:    false,
    hasShadow:    false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-overlay.js')
    }
  });

  // Always click-through — overlay is display-only
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  console.log('[overlay] Mouse events: IGNORED (fully non-interactive)');

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  // Always blur on focus — overlay should never hold focus
  overlayWindow.on('focus', () => {
    overlayWindow.blur();
  });

  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));

  // Block keyboard events so overlay never captures game inputs
  overlayWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' || input.type === 'keyUp') {
      event.preventDefault();
    }
  });

  // Crash recovery — reload renderer if it crashes
  overlayWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[overlay] Renderer crashed:', details.reason);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      setTimeout(() => {
        overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));
      }, 500);
    }
  });

  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

// ─── System Tray ───────────────────────────────────────────────────────────────
function createTray() {
  try {
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    let trayIcon;
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } else {
      trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('GhostCoach — Vanguard Safe AI Coach');
    updateTrayMenu(false);

    tray.on('double-click', () => toggleOverlay());
  } catch (err) {
    console.warn('[tray] Could not create tray icon:', err.message);
  }
}

function updateTrayMenu(isCoaching) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: isCoaching ? 'Stop Coaching' : 'Start Coaching',
      click: () => {
        // Tray coaching toggle is handled via settings IPC
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('tray:toggleCoaching');
        }
      }
    },
    {
      label: 'Show/Hide Overlay',
      click: () => toggleOverlay()
    },
    { type: 'separator' },
    {
      label: 'Quit GhostCoach',
      click: () => app.quit()
    }
  ]);
  tray.setContextMenu(menu);
}

// Toggle overlay visibility via CSS in renderer (window always stays open so
// coaching continues and the "hidden" indicator can still be shown).
function toggleOverlay() {
  overlayVisible = !overlayVisible;
  sendToOverlay('overlay:visibility', { visible: overlayVisible });

  if (tray) {
    if (overlayVisible) {
      tray.setToolTip('GhostCoach — Vanguard Safe AI Coach');
    } else {
      tray.setToolTip('GhostCoach — Hidden (still coaching)');
    }
  }

  return overlayVisible;
}

function showOverlay() {
  if (!overlayVisible) {
    overlayVisible = true;
    sendToOverlay('overlay:visibility', { visible: true });
    if (tray) tray.setToolTip('GhostCoach — Vanguard Safe AI Coach');
  }
}

function sendToOverlay(channel, data) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, data);
  }
}

function getOverlayWindow() { return overlayWindow; }
function getTray()           { return tray; }

module.exports = {
  createOverlayWindow,
  createTray,
  updateTrayMenu,
  toggleOverlay,
  showOverlay,
  sendToOverlay,
  getOverlayWindow,
  getTray
};
