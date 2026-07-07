'use strict';

/**
 * Screen capture, two engines:
 *
 *   1. NATIVE (primary): Electron's desktopCapturer, straight through the OS
 *      capture API. No PowerShell, no temp files, nothing for antivirus
 *      heuristics to flag, and faster (no process spawn per shot).
 *   2. WORKER (fallback): the original PowerShell CopyFromScreen worker
 *      thread, kept for the rare system where desktopCapturer yields nothing.
 *
 * Both return a base64 JPEG at the requested quality profile.
 */
const { desktopCapturer, screen } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const { CAPTURE } = require('../../shared/config');

// ── Native capture (primary) ─────────────────────────────────────────────────
let nativeBroken = false;   // flips true after repeated native failures
let nativeFails  = 0;

async function captureNative(quality) {
  const prof = (CAPTURE.profiles && CAPTURE.profiles[quality]) || CAPTURE.profiles.standard;
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: prof.targetW, height: prof.targetH },
  });
  if (!sources || !sources.length) throw new Error('no screen sources');
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) throw new Error('empty native capture');
  return img.toJPEG(prof.jpegQuality).toString('base64');
}

// ── PowerShell worker (fallback) ─────────────────────────────────────────────
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

function captureViaWorker(quality) {
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

// ── Public API ───────────────────────────────────────────────────────────────
async function captureScreenshot(quality) {
  if (!nativeBroken) {
    try {
      const shot = await captureNative(quality);
      nativeFails = 0;
      return shot;
    } catch (e) {
      nativeFails++;
      console.warn(`[capture] native capture failed (${nativeFails}):`, e.message);
      if (nativeFails >= 3) {
        nativeBroken = true;    // stop retrying a path that clearly doesn't work here
        console.warn('[capture] switching to PowerShell fallback for this session');
      }
    }
  }
  return captureViaWorker(quality);
}

function disposeWorker() {
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  pending = null;
}

module.exports = { captureScreenshot, disposeWorker };
