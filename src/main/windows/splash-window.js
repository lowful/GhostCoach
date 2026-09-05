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
// Callbacks waiting for the window to actually appear, and close() callbacks
// that have not run yet. Both exist because close() is routinely called BEFORE
// the splash has painted, and neither the animation nor the panel reveal may be
// lost when that happens.
let onShown = [];
let pending = [];

/** Tear it down and release everyone waiting on it. Safe to call twice. */
function destroy() {
  if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  const w = registry.get('splash');
  if (w && !w.isDestroyed()) w.close();
  shownAt = 0;
  onShown = [];
  // The callbacks are what hand the screen over to the app, so they must run
  // even when the window was already gone, or a failed splash leaves the panel
  // hidden forever.
  const ps = pending; pending = [];
  for (const fn of ps) { try { fn(); } catch { /* a stranded panel is worse */ } }
}

function open() {
  const existing = registry.get('splash');
  if (existing) return existing;

  const win = new BrowserWindow({
    // Square on purpose: the stage inside is a rounded card with a 10px
    // gutter, so 360 by 360 makes that card a true 340 square.
    width:  360,
    height: 360,
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
  shownAt = 0;
  onShown = [];
  pending = [];

  win.once('ready-to-show', () => {
    shownAt = Date.now();
    win.showInactive();       // visible, never focused
    const fns = onShown; onShown = [];
    for (const fn of fns) { try { fn(); } catch { /* never block the reveal */ } }
  });

  // The backstop force-closes rather than going through close(), which would
  // queue behind a window that may never paint and deadlock the handover.
  hardTimer = setTimeout(() => {
    const fn = onExpired;
    destroy();
    if (typeof fn === 'function') fn();
  }, MAX_MS);
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
  const win = registry.get('splash');
  if (!win || win.isDestroyed()) { if (typeof done === 'function') done(); return; }
  if (typeof done === 'function') pending.push(done);

  const runThenClose = () => setTimeout(destroy, Math.max(0, MIN_MS - (Date.now() - shownAt)));

  // THE SPLASH USUALLY IS NOT ON SCREEN YET WHEN THIS IS CALLED. Startup races
  // the loader: openAppWithSplash() closes on the panel's did-finish-load, and
  // on a warm start the panel wins, so ready-to-show has not fired and shownAt
  // is still 0.
  //
  // This used to read `shownAt ? MIN_MS - elapsed : 0`, so losing that race
  // meant a wait of ZERO and the window was destroyed before it ever painted.
  // The launch animation appeared only when the panel happened to be slow,
  // which is why it seemed to show every other launch rather than never.
  //
  // Now an unpainted splash waits to appear and then gets its full run. The
  // hard cap above is what stops a splash that never paints from hanging
  // startup, so there is still no path that strands the panel.
  if (shownAt) runThenClose();
  else onShown.push(runThenClose);
}

function get() { return registry.get('splash'); }

module.exports = { open, close, get, onTimeout };
