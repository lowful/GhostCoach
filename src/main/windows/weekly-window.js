'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * The weekly report popup: what moved this week, what the player is doing well,
 * and the one thing to work on. Opens once per calendar week when the app
 * starts, and on demand from the tray.
 *
 * Centered and focusable (unlike the overlay) because this is something to read
 * and dismiss, not something to play behind.
 */
function open() {
  const existing = registry.get('weekly');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    width:  520,
    height: 680,
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
      preload: path.join(__dirname, '../../preload/weekly-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/weekly/index.html'));
  win.once('ready-to-show', () => win.show());

  registry.register('weekly', win);
  return win;
}

function get() { return registry.get('weekly'); }

module.exports = { open, get };
