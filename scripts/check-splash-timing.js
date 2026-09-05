'use strict';

/**
 * The launch animation must actually be seen.
 *
 * THE BUG THIS EXISTS FOR. openAppWithSplash() closes the splash on the panel's
 * did-finish-load, and on a warm start the panel wins that race, so close() runs
 * before the splash has painted. close() computed its wait as
 * `shownAt ? MIN_MS - elapsed : 0`, and an unpainted splash has shownAt === 0,
 * so the wait was ZERO and the window was destroyed before it ever appeared.
 * The animation showed only when the panel happened to be slow, which is why it
 * looked like it appeared every other launch rather than never.
 *
 * Nothing else in this repo could catch that. The window config was right, the
 * CSS was right, and a screenshot of the surface looks perfect. Only the timing
 * between two windows was wrong, so only a real launch shows it.
 *
 * Cases:
 *   immediate  close() before ready-to-show. The bug. Must still be seen.
 *   settled    close() after it is on screen. Must still get its full run.
 *   stranded   close() never called. The hard cap must hand over anyway, or a
 *              splash that fails to load hides the panel forever.
 *
 * Results travel through a FILE, not stdout: an Electron main process on Windows
 * does not reliably flush a piped stdout, which made every child look silent
 * even when it passed.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');

const MIN_MS = 2400;    // must match splash-window.js
const MAX_MS = 4500;
const TOL = 250;        // scheduler slop

const OUT = path.join(os.tmpdir(), 'occlara-splash-check.json');

// Parent: run each case under Electron and report.
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require('electron');
  const CASES = ['immediate', 'settled', 'stranded'];
  let bad = 0;

  for (const c of CASES) {
    try { fs.unlinkSync(OUT); } catch { /* nothing to clear on the first run */ }
    const env = Object.assign({}, process.env, { OCCLARA_SPLASH_CASE: c, OCCLARA_SPLASH_OUT: OUT });
    // This shell exports ELECTRON_RUN_AS_NODE=1, which makes the Electron
    // binary run as plain node and the app dies with a misleading error.
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [__filename], { env, timeout: 90000 });

    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* reported below */ }

    if (!rec) {
      console.error('  FAIL [' + c + '] the case wrote no result (exit ' + r.status + ')');
      bad += 1;
      continue;
    }
    console.log('  ' + (rec.ok ? 'PASS' : 'FAIL') + ' [' + c + '] ' + rec.detail);
    if (!rec.ok || r.status !== 0) bad += 1;
  }

  if (bad) { console.error('FAIL: ' + bad + ' of ' + CASES.length + ' splash cases wrong'); process.exit(1); }
  console.log('PASS: the launch animation is always seen, and never strands the panel');
  process.exit(0);
}

// Child: drive the real splash window.
const CASE = process.env.OCCLARA_SPLASH_CASE || 'immediate';
const { app } = require('electron');
const splash = require(path.join(REPO, 'src/main/windows/splash-window'));

let reported = false;
function report(ok, detail) {
  if (reported) return;
  reported = true;
  try {
    fs.writeFileSync(process.env.OCCLARA_SPLASH_OUT || OUT, JSON.stringify({ case: CASE, ok, detail }));
  } catch { /* the exit code still carries the verdict */ }
  app.exit(ok ? 0 : 1);
}

app.disableHardwareAcceleration();
// Closing the splash leaves zero windows, and Electron quits on that by default,
// which killed the process before the assertions below could run. Every case
// then reported "no result" with exit 0, which looks like a broken harness
// rather than the deliberate teardown it is.
app.on('window-all-closed', () => { /* the timer below decides when we exit */ });

app.whenReady().then(() => {
  const t0 = Date.now();
  let shownAt = 0;
  let handedOver = 0;

  const win = splash.open();
  if (!win) return report(false, 'open() returned nothing');
  win.on('show', () => { shownAt = Date.now(); });

  const handOver = () => { handedOver = Date.now(); };

  if (CASE === 'immediate') {
    splash.close(handOver);                 // the real race, before it can paint
  } else if (CASE === 'settled') {
    win.once('ready-to-show', () => setTimeout(() => splash.close(handOver), 300));
  } else {
    splash.onTimeout(handOver);             // never closed: only the cap can save the panel
  }

  setTimeout(() => {
    const seenFor = shownAt && handedOver ? handedOver - shownAt : 0;
    const when = 'shown +' + (shownAt ? shownAt - t0 : -1) + 'ms, handover +'
      + (handedOver ? handedOver - t0 : -1) + 'ms, visible ' + seenFor + 'ms';

    if (!handedOver) return report(false, 'the panel was never handed over, it would stay hidden forever');

    if (CASE === 'stranded') {
      if (handedOver - t0 > MAX_MS + 1500) return report(false, 'hard cap did not fire near MAX_MS. ' + when);
      return report(true, 'hard cap handed over at +' + (handedOver - t0) + 'ms');
    }

    if (!shownAt) return report(false, 'the splash was NEVER shown, the animation was skipped entirely. ' + when);
    if (seenFor < MIN_MS - TOL) {
      return report(false, 'visible only ' + seenFor + 'ms, expected at least ' + MIN_MS + 'ms, so it was cut off. ' + when);
    }
    report(true, when);
  }, MAX_MS + 3000);
});
