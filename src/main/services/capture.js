'use strict';

/**
 * Main-thread handle to the capture worker. Posts a message, awaits a base64
 * JPEG. One capture in flight at a time; the worker respawns on error/exit.
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

function captureScreenshot() {
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

    w.postMessage('capture');
  });
}

function disposeWorker() {
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  pending = null;
}

module.exports = { captureScreenshot, disposeWorker };
