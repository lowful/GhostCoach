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

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-surface-shots');

// Width each surface is actually shown at, so the shot matches what ships
// rather than an arbitrary window. Height is generous and the page is captured
// at its own content height where it reports one.
const SIZES = {
  panel: [420, 268], settings: [560, 760], stats: [980, 760], history: [560, 640],
  ailog: [900, 640], chat: [520, 600], weekly: [560, 700], onboarding: [720, 620],
  activation: [460, 560], dock: [220, 120], overlay: [520, 400], splash: [420, 420],
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
      // A screenshot needs an opaque ground or the card renders on black-on-black
      // and the whole point of looking is lost.
      backgroundColor: '#08090A',
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
    });

    try {
      await win.loadFile(file);
      // Let fonts settle and entrance animations finish, or every shot catches
      // the interface mid-fade and looks broken.
      await new Promise((r) => setTimeout(r, 1800));
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
