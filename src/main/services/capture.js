'use strict';

/**
 * Screen capture in a Worker Thread + child process, entirely OFF the main and
 * render threads and off the game's render path, so it never causes an in-game
 * hitch. The capture itself is the fast GDI CopyFromScreen primitive, run from
 * a small compiled helper exe (GhostCoachCapture.exe) rather than powershell.
 * That is deliberate: the identical PowerShell script matched Windows Defender's
 * PowerShell Empire "Get-Screenshot" signature and got flagged as a HackTool on
 * users' machines. The compiled exe is the same speed with none of that. The
 * PowerShell path survives only as a fallback for the (unexpected) case where
 * the exe is missing from the package.
 *
 * Returns a base64 JPEG at the requested quality profile.
 */
const { Worker } = require('worker_threads');
const path = require('path');
const fs   = require('fs');
const { CAPTURE } = require('../../shared/config');

let worker  = null;
let pending = null;

// Packaged: shipped to resources/ via electron-builder extraResources.
// Dev: the compiled exe sits in the repo's native/ folder.
function resolveHelperExe() {
  const candidates = [
    path.join(process.resourcesPath || '', 'GhostCoachCapture.exe'),
    path.join(__dirname, '..', '..', '..', 'native', 'GhostCoachCapture.exe'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'capture-worker.js'), {
    workerData: { helperExe: resolveHelperExe() },
  });

  worker.on('message', (msg) => {
    if (!pending) return;
    const p = pending; pending = null;
    if (msg.success) p.resolve(msg.data);
    else             p.reject(new Error(msg.error || 'Capture failed'));
  });
  worker.on('error', (err) => {
    if (pending) { pending.reject(err); pending = null; }
    worker = null; // respawn on next call
  });
  worker.on('exit', (code) => {
    if (pending) { pending.reject(new Error(`Capture worker exited (${code})`)); pending = null; }
    worker = null;
  });

  return worker;
}

function captureScreenshot(quality) {
  return new Promise((resolve, reject) => {
    if (pending) { reject(new Error('Capture already in progress')); return; }

    const w = getWorker();
    const timer = setTimeout(() => {
      if (pending) { pending.reject(new Error('Capture timeout')); pending = null; }
    }, CAPTURE.timeoutMs);

    pending = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    };

    w.postMessage({ quality: quality || 'standard' });
  });
}

function disposeWorker() {
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  pending = null;
}

module.exports = { captureScreenshot, disposeWorker };
