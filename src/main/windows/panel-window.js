'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const registry = require('./registry');
const store = require('../services/store');

/**
 * Small frameless, interactive, always-on-top control panel. This is the
 * premium glass hub: Start/Stop, Pause, Force-tip, status, recent tips,
 * Settings + Quit. Draggable via CSS -webkit-app-region; position persisted.
 */
const WIDTH = 360;
const HEIGHT = 200; // initial only, the panel auto-resizes to its content (setContentHeight)

function create() {
  const saved = store.get('panelBounds');
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw } = display.workArea;

  const x = saved && Number.isFinite(saved.x) ? saved.x : dx + dw - WIDTH - 24;
  const y = saved && Number.isFinite(saved.y) ? saved.y : dy + 24;

  const win = new BrowserWindow({
    x, y,
    width:  WIDTH,
    height: HEIGHT,
    minWidth:  WIDTH,
    minHeight: HEIGHT,
    transparent: true,
    frame:       false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared channels registry
      preload: path.join(__dirname, '../../preload/panel-preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '../../renderer/panel/index.html'));
  // showInactive so appearing/refreshing never steals focus from the game.
  win.once('ready-to-show', () => win.showInactive());

  // Persist position when the user drags the panel.
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    store.set('panelBounds', { x: b.x, y: b.y });
  };
  win.on('moved', saveBounds);

  registry.register('panel', win);
  return win;
}

function get() { return registry.get('panel'); }

/** Resize the window to fit the panel's content height (keeps x/y/width). */
function setContentHeight(h) {
  const win = get();
  if (!win || win.isDestroyed() || minimized) return;
  const height = Math.max(140, Math.min(640, Math.round(h)));
  const b = win.getBounds();
  if (Math.abs(b.height - height) <= 1) return;
  win.setBounds({ x: b.x, y: b.y, width: b.width, height });
}

let minimized = false;

/** Hide/show the interactive panel so the cursor can't catch it mid-game. */
function setMinimized(value) {
  const win = get();
  if (!win) return minimized;
  minimized = !!value;
  if (minimized) win.hide();
  else { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); }
  store.set('panelMinimized', minimized);
  return minimized;
}

function toggleMinimized() { return setMinimized(!minimized); }
function isMinimized() { return minimized; }

/** Where the dock badge should sit, the panel's top-right corner. */
function getDockAnchor(dockSize = 56) {
  const win = get();
  if (!win) return null;
  const b = win.getBounds();
  return { x: b.x + b.width - dockSize, y: b.y };
}

module.exports = { create, get, setMinimized, toggleMinimized, isMinimized, getDockAnchor, setContentHeight };
