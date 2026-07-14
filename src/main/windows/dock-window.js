'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * Tiny, fully click-through ghost badge shown where the panel was docked when
 * the user minimizes. It CANNOT be clicked (setIgnoreMouseEvents) so it never
 * catches the cursor mid-aim, restore is via hotkey (Ctrl+Shift+M) or tray.
 */
// Window is larger than the 30x35 badge artwork so its drop-shadow + red glow
// have transparent room and never clip at the window edge. Safe to oversize
// because the dock is fully click-through (setIgnoreMouseEvents below).
const SIZE = 84;

function ensure() {
  let win = registry.get('dock');
  if (win) return win;

  win = new BrowserWindow({
    width: SIZE, height: SIZE,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, focusable: false, hasShadow: false, show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      preload: path.join(__dirname, '../../preload/dock-preload.js'),
    },
  });

  win.setIgnoreMouseEvents(true);            // fully click-through
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '../../renderer/dock/index.html'));
  registry.register('dock', win);
  return win;
}

function showAt(anchor) {
  const win = ensure();
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    win.setPosition(Math.round(anchor.x), Math.round(anchor.y));
  }
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function hide() {
  const win = registry.get('dock');
  if (win) win.hide();
}

module.exports = { showAt, hide, SIZE };
