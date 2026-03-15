const { BrowserWindow } = require('electron');
const path = require('path');

let settingsWindow = null;

// FIX 3: Accept initial coaching state so the settings window reflects
// the current state immediately on open. Closing settings NEVER touches
// the coaching loop — only `settingsWindow = null` cleanup happens here.
function createSettingsWindow(initialState) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    // Re-send state in case it drifted while window was in background
    if (initialState) settingsWindow.webContents.send('settings:state', initialState);
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 600,
    title: 'GhostCoach Settings',
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-settings.js')
    },
    backgroundColor: '#0F1923'
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings/index.html'));

  // Send current coaching state once the renderer is ready
  if (initialState) {
    settingsWindow.webContents.once('did-finish-load', () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('settings:state', initialState);
      }
    });
  }

  // Only clean up the window reference — never modify coaching state
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function sendToSettings(channel, data) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, data);
  }
}

function getSettingsWindow() { return settingsWindow; }

module.exports = { createSettingsWindow, sendToSettings, getSettingsWindow };
