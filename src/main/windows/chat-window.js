'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * "Ask Coach": a focusable chat window for talking with the AI about the
 * session, especially post-match ("what did I do wrong?"). Unlike the overlay
 * surfaces this one is meant to be typed in, so it takes focus normally.
 */
const WIDTH = 420;
const HEIGHT = 600;

function open() {
  const existing = registry.get('chat');
  if (existing) { existing.show(); existing.focus(); return existing; }

  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width:  WIDTH,
    height: HEIGHT,
    x: workArea.x + workArea.width - WIDTH - 24,
    y: workArea.y + Math.round((workArea.height - HEIGHT) / 2),
    frame:       false,
    resizable:   false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show:        false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared channels registry
      preload: path.join(__dirname, '../../preload/chat-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/chat/index.html'));
  win.once('ready-to-show', () => win.show());

  registry.register('chat', win);
  return win;
}

module.exports = { open };
