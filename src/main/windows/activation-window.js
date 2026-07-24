'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * Frameless, centered license activation window. First surface the user sees
 * when no valid license is cached. Closes itself once activation succeeds and
 * the main app launches.
 */
function create(reason) {
  const existing = registry.get('activation');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    // Fitted to the card. The window is transparent, so any spare area around
    // the card is invisible but still swallows clicks meant for what is behind.
    width:  424,
    height: 524,
    frame:       false,
    resizable:   false,
    transparent: true,
    center:      true,
    skipTaskbar: false,
    show:        false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared channels registry
      preload: path.join(__dirname, '../../preload/activation-preload.js'),
    },
  });

  const htmlPath = path.join(__dirname, '../../renderer/activation/index.html');
  win.loadFile(htmlPath, reason ? { query: { notice: String(reason) } } : undefined);
  win.once('ready-to-show', () => win.show());

  registry.register('activation', win);
  return win;
}

function get() { return registry.get('activation'); }

function close() {
  const win = registry.get('activation');
  if (win) win.close();
}

module.exports = { create, get, close };
