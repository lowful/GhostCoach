'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * Frameless interactive settings window. Opened on demand from the panel,
 * tray, or hotkey. Single instance, focus if already open.
 */
function open() {
  const existing = registry.get('settings');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    width:  520,
    height: 620,
    frame:       false,
    resizable:   false,
    transparent: true,
    skipTaskbar: false,
    center:      true,
    show:        false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared channels registry
      preload: path.join(__dirname, '../../preload/settings-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/settings/index.html'));
  win.once('ready-to-show', () => win.show());

  registry.register('settings', win);
  return win;
}

function get() { return registry.get('settings'); }

module.exports = { open, get };
