const { globalShortcut } = require('electron');

/**
 * Registers global hotkeys.
 * @param {{ toggleOverlay, forceCapture, pauseResume, openSettings, minimizeOverlay, quit }} handlers
 */
function registerHotkeys({ toggleOverlay, forceCapture, pauseResume, openSettings, minimizeOverlay, quit }) {
  const keys = [
    ['CommandOrControl+Shift+G', toggleOverlay,   'Ctrl+Shift+G (toggle overlay)'],
    ['CommandOrControl+Shift+P', pauseResume,      'Ctrl+Shift+P (pause/resume)'],
    ['CommandOrControl+Shift+S', forceCapture,     'Ctrl+Shift+S (force capture)'],
    ['CommandOrControl+Shift+C', toggleOverlay,    'Ctrl+Shift+C (toggle — legacy)'],
    ['CommandOrControl+Shift+Q', openSettings,     'Ctrl+Shift+Q (open settings)'],
    ['CommandOrControl+Shift+M', minimizeOverlay,  'Ctrl+Shift+M (minimize panel)'],
    ['CommandOrControl+Shift+X', quit,             'Ctrl+Shift+X (quit)'],
  ];

  for (const [accelerator, handler, label] of keys) {
    if (!handler) continue;
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (ok) console.log(`[hotkeys] Registered: ${label}`);
      else    console.warn(`[hotkeys] Failed to register: ${label} (key may be in use)`);
    } catch (err) {
      console.warn(`[hotkeys] Error registering ${label}:`, err.message);
    }
  }
}

function unregisterHotkeys() {
  globalShortcut.unregisterAll();
}

module.exports = { registerHotkeys, unregisterHotkeys };
