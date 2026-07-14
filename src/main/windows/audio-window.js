'use strict';

const { BrowserWindow, session, desktopCapturer } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * Hidden game-audio listener. Captures Windows loopback audio (what the
 * player hears) into a rolling in-memory buffer and pushes a short WAV clip
 * to main every few seconds. Nothing is ever written to disk; the window
 * exists only while a coaching session runs. The clips power death
 * forensics: the sounds right before a death usually explain it better
 * than any frame.
 */
let handlerSet = false;
function ensureDisplayMediaHandler() {
  if (handlerSet) return;
  handlerSet = true;
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });
}

function create() {
  const existing = registry.get('audio');
  if (existing) return existing;
  ensureDisplayMediaHandler();

  const win = new BrowserWindow({
    width: 120, height: 80,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared channels registry
      preload: path.join(__dirname, '../../preload/audio-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/audio/index.html'));
  registry.register('audio', win);
  return win;
}

function destroy() {
  const win = registry.get('audio');
  if (win && !win.isDestroyed()) win.destroy();
}

module.exports = { create, destroy };
