'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * Frameless extended stats dashboard: overview cards, recent tracker matches
 * with ratings, and expandable coached-session history.
 * Single instance, focus if already open.
 */
function open() {
  const existing = registry.get('stats');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    width:  560,
    height: 720,
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
      preload: path.join(__dirname, '../../preload/stats-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/stats/index.html'));
  win.once('ready-to-show', () => win.show());

  registry.register('stats', win);
  return win;
}

function get() { return registry.get('stats'); }

module.exports = { open, get };
