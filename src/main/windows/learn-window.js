'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * The League learning surface.
 *
 * Taller and RESIZABLE, unlike the other popups. Every other window in this app
 * shows a fixed amount of information and is sized to fit it exactly; this one
 * holds a lesson someone is reading, and the right height for that depends on
 * the person and the monitor rather than on the content.
 */
function open() {
  const existing = registry.get('learn');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    width:  560,
    height: 720,
    minWidth:  460,
    minHeight: 520,
    frame:       false,
    resizable:   true,
    transparent: true,
    center:      true,
    skipTaskbar: false,
    show:        false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared modules
      preload: path.join(__dirname, '../../preload/learn-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/learn/index.html'));
  win.once('ready-to-show', () => win.show());

  registry.register('learn', win);
  return win;
}

function get() { return registry.get('learn'); }

function close() {
  const win = registry.get('learn');
  if (win) win.close();
}

module.exports = { open, get, close };
