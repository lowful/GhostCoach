'use strict';

/**
 * Capture frames of the launch animation so it can actually be looked at
 * instead of only compiled. Dev tool, never shipped: electron-builder only
 * packages src/ and assets/.
 *
 * Run: npx electron scripts/shot-splash.js <outputDir>
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.argv[2] || path.join(__dirname, '..', 'dist-splash-frames');
const LOG = path.join(OUT, 'run.log');
const say = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch {} };

// Frames across the sequence: mark landing, scan sweeping, wordmark settling,
// bar completing, fade out.
const AT_MS = [420, 760, 1050, 1320, 1480, 1700];

app.disableHardwareAcceleration();
process.on('uncaughtException', (e) => { say('FATAL ' + (e && e.stack)); app.exit(1); });

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, 'start\n');

  const win = new BrowserWindow({
    width: 360, height: 340,
    x: -2000, y: 0,             // offscreen, but composited so capture works
    frame: false, show: true, transparent: false,
    // A mid grey stand-in for the desktop. The real window is transparent, and
    // a dark backdrop hides exactly the artefacts worth checking for, such as a
    // drop shadow reading as a halo. Grey shows them.
    backgroundColor: process.env.SPLASH_BG || '#0a121a',
    webPreferences: { backgroundThrottling: false },
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'splash', 'index.html'));
  say('loaded');

  const t0 = Date.now();
  for (const at of AT_MS) {
    const wait = at - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const buf = (await win.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(OUT, `frame-${String(at).padStart(4, '0')}ms.png`), buf);
    say(`frame ${at}ms bytes=${buf.length}`);
  }

  say('done');
  app.exit(0);
});
