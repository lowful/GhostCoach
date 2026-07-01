'use strict';

/**
 * Central registry of live BrowserWindows + a single broadcast helper so engine
 * events fan out to overlay/panel/settings without per-call window lookups.
 * Window modules register/unregister themselves on create/closed.
 */
const windows = new Map(); // name → BrowserWindow

function register(name, win) {
  windows.set(name, win);
  forwardConsole(name, win);
  win.on('closed', () => {
    if (windows.get(name) === win) windows.delete(name);
  });
}

/**
 * Tee every renderer's console into the main-process log (→ debug.log). This is
 * how a broken preload/bridge surfaces instead of failing silently, the exact
 * class of bug that killed the old client. Handles both the legacy positional
 * and the newer details-object 'console-message' signatures.
 */
function forwardConsole(name, win) {
  win.webContents.on('console-message', (...args) => {
    let level, message, sourceId, line;
    if (args.length >= 2 && args[1] && typeof args[1] === 'object' && 'message' in args[1]) {
      ({ level, message, sourceId, lineNumber: line } = args[1]);
    } else {
      [, level, message, line, sourceId] = args;
    }
    const src = String(sourceId || '').split(/[\\/]/).pop();
    const text = `[renderer:${name}] ${message}${src ? ` (${src}:${line})` : ''}`;
    if (String(level).toLowerCase() === 'error' || level === 3) console.error(text);
    else console.log(text);
  });
}

function get(name) {
  const w = windows.get(name);
  return w && !w.isDestroyed() ? w : null;
}

/** Send to a single window if it exists. */
function sendTo(name, channel, data) {
  const w = get(name);
  if (w) w.webContents.send(channel, data);
}

/** Send to every live window (used for engine push events). */
function broadcast(channel, data) {
  for (const [, w] of windows) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, data);
  }
}

module.exports = { register, get, sendTo, broadcast };
