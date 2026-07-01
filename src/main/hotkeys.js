'use strict';

const { globalShortcut } = require('electron');

/**
 * Global hotkeys. `actions` injects handlers. Registration failures (e.g. a key
 * already grabbed by another app) are logged, never thrown.
 */
const BINDINGS = {
  'CommandOrControl+Shift+C': 'toggleOverlay',
  'CommandOrControl+Shift+X': 'forceTip',
  'CommandOrControl+Shift+P': 'pauseResume',
  'CommandOrControl+Shift+M': 'minimizePanel',
  'CommandOrControl+Shift+H': 'openHistory',
  'CommandOrControl+Shift+S': 'openSettings',
};

function register(actions) {
  for (const [accel, action] of Object.entries(BINDINGS)) {
    try {
      const ok = globalShortcut.register(accel, () => {
        try { actions[action]?.(); }
        catch (err) { console.error(`[hotkeys] ${action} failed:`, err.message); }
      });
      if (!ok) console.warn(`[hotkeys] Failed to register ${accel}`);
    } catch (err) {
      console.warn(`[hotkeys] Error registering ${accel}:`, err.message);
    }
  }
}

function unregister() {
  globalShortcut.unregisterAll();
}

module.exports = { register, unregister, BINDINGS };
