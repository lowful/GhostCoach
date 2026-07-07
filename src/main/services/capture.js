'use strict';

/**
 * Screen capture via PowerShell CopyFromScreen in a Worker Thread + child
 * process. All the heavy work happens OFF the main/render thread and off the
 * game's render path, so it never causes an in-game hitch. This is the only
 * capture engine: the in-process native capturer duplicates the framebuffer
 * and stutters fullscreen games, so if PowerShell is ever blocked (antivirus)
 * we surface a "add an exclusion" message rather than fall back to a laggy path.
 *
 * Returns a base64 JPEG at the requested quality profile.
 */
const { Worker } = require('worker_threads');
const path = require('path');
const { CAPTURE } = require('../../shared/config');

let worker  = null;
let pending = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'capture-worker.js'));

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
