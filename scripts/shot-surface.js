'use strict';

/**
 * Screenshot any renderer surface so a design change can be LOOKED AT rather
 * than only compiled.
 *
 * shot-splash.js already does this for the launch animation, and the rebrand
 * made the gap obvious: every other surface could only be verified by reading
 * CSS and hoping. A palette edit that silently drops a declaration, a font that
 * falls back because its weight is not shipped, and a logo stretched by a
 * changed aspect ratio all pass every automated check in this repo and are
 * instantly obvious in a picture.
 *
 * Dev tool, never shipped: electron-builder only packages src/ and assets/.
 *
 *   npx electron scripts/shot-surface.js panel settings stats
 *   npx electron scripts/shot-surface.js --all
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// loadFile intermittently rejects with ERR_FAILED here, most often on any
// window after the first in a process. It succeeds on a retry, so retry rather
// than reporting a surface as broken.
async function loadWithRetry(win, file, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { await win.loadFile(file); return true; }
    catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  return false;
}

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-surface-shots');

// The size each surface is ACTUALLY shown at, read from src/main/windows/*.
// These were previously rough guesses, and the guesses were not harmless: at
// 720x620 the onboarding card composites its glass layer differently and the
// white logo captured as rgb(46,47,48), a bug that does not exist at the real
// 480x528. A screenshot tool that invents defects is worse than none, so keep
// this table in sync with the window modules.
//
// panel height is its initial 200 plus room for the content it auto-resizes to.
const SIZES = {
  panel: [420, 268], settings: [520, 620], stats: [560, 720], history: [440, 560],
  ailog: [900, 640], chat: [420, 600], weekly: [520, 680], onboarding: [480, 528],
  activation: [424, 524], dock: [84, 84], overlay: [520, 400], splash: [360, 340],
  learn: [560, 720],
};

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wanted = process.argv.includes('--all') ? Object.keys(SIZES) : (args.length ? args : ['panel']);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  for (const name of wanted) {
    const file = path.join(ROOT, 'src', 'renderer', name, 'index.html');
    if (!fs.existsSync(file)) { console.log(`skip ${name}: no index.html`); continue; }
    const [w, h] = SIZES[name] || [520, 600];

    const win = new BrowserWindow({
      width: w, height: h, show: false, frame: false,
      // The surfaces are transparent by design and composite onto the desktop.
      // A screenshot needs an opaque ground or the card renders black-on-black
      // and the whole point of looking is lost.
      backgroundColor: '#08090A',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    try {
      if (!await loadWithRetry(win, file)) { console.log(`FAILED ${name}: could not load`); continue; }
      // Let fonts settle and entrance animations finish, or every shot catches
      // the interface mid-fade and looks broken.
      //
      // 1800ms was not enough and the way it failed was nasty: onboarding
      // stacks float + countIn on the logo inside a hero running riseIn, and at
      // 1800ms the mark captured as rgb(46,47,48) instead of white. That reads
      // as a dead logo rather than as a half-finished animation, so it looks
      // exactly like the currentColor bug this repo has actually had. At 2200ms
      // the same pixel is rgb(255,255,255). 3000ms buys margin on a slow
      // machine: a screenshot tool that reports a bug that is not there costs
      // far more than a second per surface.
      await new Promise((r) => setTimeout(r, 3000));
      const img = await win.capturePage();
      const out = path.join(OUT, `${name}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log(`shot ${name} -> ${path.relative(ROOT, out)}`);
    } catch (e) {
      console.log(`FAILED ${name}: ${e.message}`);
    } finally {
      win.destroy();
    }
  }
  app.quit();
});
