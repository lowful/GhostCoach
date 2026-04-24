/**
 * Screen capture — runs entirely inside a Worker Thread.
 * Main thread only posts a message and awaits a base64 string.
 * No PowerShell spawn, no fs.readFileSync, no JPEG buffer ever touches main.
 */

'use strict';
const { Worker } = require('worker_threads');
const path = require('path');

let captureWorker = null;
let pending       = null;

function getWorker() {
  if (captureWorker) return captureWorker;
  captureWorker = new Worker(path.join(__dirname, 'capture-worker.js'));

  captureWorker.on('message', (msg) => {
    if (!pending) return;
    const p = pending; pending = null;
    if (msg.success) p.resolve(msg.data);
    else             p.reject(new Error(msg.error || 'Capture failed'));
  });

  captureWorker.on('error', (err) => {
    if (pending) { pending.reject(err); pending = null; }
    captureWorker = null; // force respawn next call
  });

  captureWorker.on('exit', (code) => {
    if (pending) { pending.reject(new Error(`Worker exited (${code})`)); pending = null; }
    captureWorker = null;
  });

  return captureWorker;
}

function captureScreenshot() {
  return new Promise((resolve, reject) => {
    if (pending) { reject(new Error('Capture already in progress')); return; }
    const worker = getWorker();
    pending = { resolve, reject };

    const timer = setTimeout(() => {
      if (pending) { pending.reject(new Error('Capture timeout')); pending = null; }
    }, 6000);

    const origResolve = resolve;
    const origReject  = reject;
    pending.resolve = (v) => { clearTimeout(timer); origResolve(v); };
    pending.reject  = (e) => { clearTimeout(timer); origReject(e);  };

    worker.postMessage('capture');
  });
}

module.exports = { captureScreenshot };
