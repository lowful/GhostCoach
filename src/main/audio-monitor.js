'use strict';

const { BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

let audioWindow  = null;
let _onEvent     = null;
let _ipcBound    = false;

// ─── IPC (register once, not per window) ──────────────────────────────────────
function ensureIpc() {
  if (_ipcBound) return;
  _ipcBound = true;

  ipcMain.handle('audio:getSourceId', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      return sources[0]?.id || null;
    } catch (err) {
      console.warn('[audio-monitor] desktopCapturer failed:', err.message);
      return null;
    }
  });

  ipcMain.on('audio:event', (_, state) => {
    if (_onEvent) _onEvent(state);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startAudioMonitor(onEvent) {
  ensureIpc();
  _onEvent = onEvent;

  if (audioWindow && !audioWindow.isDestroyed()) return;

  audioWindow = new BrowserWindow({
    width: 1, height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-audio.js'),
    },
  });

  audioWindow.loadFile(path.join(__dirname, '../renderer/audio/audio.html'));
  audioWindow.on('closed', () => { audioWindow = null; });

  console.log('[audio-monitor] Started');
}

function stopAudioMonitor() {
  _onEvent = null;
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.destroy();
    audioWindow = null;
  }
  console.log('[audio-monitor] Stopped');
}

module.exports = { startAudioMonitor, stopAudioMonitor };
