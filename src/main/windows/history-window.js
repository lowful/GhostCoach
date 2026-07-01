'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * Frameless tip-history window. Lists every tip from the current session.
 * Single instance, focus if already open.
 */
function open() {
  const existing = registry.get('history');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    width:  440,
    height: 560,
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
      preload: path.join(__dirname, '../../preload/history-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/history/index.html'));
  win.once('ready-to-show', () => win.show());

  registry.register('history', win);
  return win;
}

function get() { return registry.get('history'); }

module.exports = { open, get };
