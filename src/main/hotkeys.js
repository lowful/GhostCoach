'use strict';

const { globalShortcut } = require('electron');

/**
 * Global hotkeys. `actions` injects handlers. Registration failures (e.g. a key
 * already grabbed by another app) are logged, never thrown.
 */
const BINDINGS = {
  'CommandOrControl+Shift+X': 'forceTip',
  'CommandOrControl+Shift+P': 'pauseResume',
  'CommandOrControl+Shift+M': 'minimizePanel',
  'CommandOrControl+Shift+S': 'openSettings',
  // Developer joke tip. The key is always bound, but the action does nothing
  // unless devJokeTips is set in the config, which has no Settings UI. Binding
  // it unconditionally keeps this file a plain list rather than something that
  // has to read config to know what it registers.
  'CommandOrControl+Shift+J': 'jokeTip',
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
