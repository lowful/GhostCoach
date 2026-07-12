'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * Transparent, always-on-top, fully click-through HUD that fills the primary
 * display. Display-only: renders tip cards + a status pill. All interaction
 * lives in the separate control panel window.
 */
let overlayVisible = true;

function create() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame:       false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    movable:     false,
    focusable:   false,
    hasShadow:   false,
    show:        false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared channels registry
      preload: path.join(__dirname, '../../preload/overlay-preload.js'),
    },
  });

  // Fully click-through, clicks pass to the game beneath.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  // Overlay must never hold focus or capture game input.
  win.on('focus', () => win.blur());
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' || input.type === 'keyUp') event.preventDefault();
  });

  // Auto-recover if the renderer crashes.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[overlay] Renderer gone:', details.reason);
    if (win && !win.isDestroyed()) {
      setTimeout(() => win.loadFile(htmlPath()), 500);
    }
  });

  win.loadFile(htmlPath());
  win.once('ready-to-show', () => win.show());

  registry.register('overlay', win);
  return win;
}

function htmlPath() {
  return path.join(__dirname, '../../renderer/overlay/index.html');
}

function get() { return registry.get('overlay'); }

function setVisible(visible) {
  overlayVisible = visible;
  registry.sendTo('overlay', require('../../shared/channels').PUSH_OVERLAY_VIS, { visible });
  return overlayVisible;
}

function toggleVisible() { return setVisible(!overlayVisible); }

/** Temporarily accept mouse input (cursor over the review card's ✕), then
 *  back to fully click-through with event forwarding. */
function setInteractive(on) {
  const win = get();
  if (!win || win.isDestroyed()) return;
  if (on) win.setIgnoreMouseEvents(false);
  else    win.setIgnoreMouseEvents(true, { forward: true });
}

module.exports = { create, get, setVisible, toggleVisible, setInteractive };
