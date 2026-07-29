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

// Frames across the sequence: ghost landing, scan sweeping, wordmark settling,
// bar completing, fade out.
const AT_MS = [260, 620, 900, 1200, 1500, 1750];

app.disableHardwareAcceleration();
process.on('uncaughtException', (e) => { say('FATAL ' + (e && e.stack)); app.exit(1); });

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, 'start\n');

  const win = new BrowserWindow({
    width: 360, height: 340,
    x: -2000, y: 0,             // offscreen, but composited so capture works
    frame: false, show: true, transparent: false,
    backgroundColor: '#0a121a', // solid, so the PNG is not an alpha soup
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
