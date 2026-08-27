'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * The launch animation, shown while the app wires itself up.
 *
 * Deliberately has NO preload and no IPC: it is purely visual, so giving it a
 * bridge would be surface area for nothing. It cannot be focused or clicked,
 * because stealing focus from whatever the player is doing (often a game that
 * is already running) to show a logo would be rude.
 *
 * Lifetime is owned by the main process, not the page. close() is safe to call
 * at any point, and a hard cap guarantees the window cannot outlive its welcome
 * if something in startup hangs.
 */

// The CSS sequence runs about 2.4s. Anything faster than MIN_MS cuts the
// animation off mid stride, which looks broken rather than snappy; MAX_MS is
// the backstop so a stalled startup never leaves it on screen.
const MIN_MS = 2400;
const MAX_MS = 4500;

let shownAt = 0;
let hardTimer = null;

function open() {
  const existing = registry.get('splash');
  if (existing) return existing;

  const win = new BrowserWindow({
    width:  360,
    height: 340,
    frame:       false,
    resizable:   false,
    movable:     false,
    transparent: true,
    center:      true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable:   false,   // never steal focus, the player may be mid game
    show:        false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,   // nothing to require, so keep it locked down
    },
  });

  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, '../../renderer/splash/index.html'));
  win.once('ready-to-show', () => {
    shownAt = Date.now();
    win.showInactive();       // visible, never focused
  });

  hardTimer = setTimeout(() => close(onExpired), MAX_MS);
  registry.register('splash', win);
  return win;
}

// Run if the hard cap fires, so a startup that never finishes loading still
// hands the screen over to the app rather than hiding it behind a dead splash.
let onExpired = null;
function onTimeout(fn) { onExpired = fn; }

/**
 * Close it, but never before the animation has had its full run. Startup often
 * finishes in a few hundred milliseconds, and blinking the loader away that
 * fast reads as a glitch, so the remaining time is waited out.
 */
function close(done) {
  const finish = () => { if (typeof done === 'function') done(); };
  const win = registry.get('splash');
  if (!win) { finish(); return; }

  const elapsed = Date.now() - shownAt;
  const wait = shownAt ? Math.max(0, MIN_MS - elapsed) : 0;

  setTimeout(() => {
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    const w = registry.get('splash');
    if (w && !w.isDestroyed()) w.close();
    // The callback is what hands the screen over to the app, so it must run
    // even if the window was already gone, otherwise a failed splash would
    // leave the panel hidden forever.
    finish();
  }, wait);
}

function get() { return registry.get('splash'); }

module.exports = { open, close, get, onTimeout };
