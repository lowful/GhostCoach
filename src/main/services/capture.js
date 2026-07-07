'use strict';

/**
 * Screen capture, two engines:
 *
 *   1. WORKER (primary): PowerShell CopyFromScreen in a Worker Thread + child
 *      process. All the heavy work happens OFF the main/render thread and off
 *      the game's render path, so it never causes a capture hitch. This is the
 *      method that plays clean in-game.
 *   2. NATIVE (fallback only): Electron's desktopCapturer. Convenient but it
 *      runs in-process and on Windows forces a framebuffer duplication that can
 *      stutter a fullscreen game, so it is used ONLY if the worker path fails
 *      (e.g. an antivirus blocks PowerShell on some machine).
 *
 * Both return a base64 JPEG at the requested quality profile.
 */
const { desktopCapturer, screen } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const { CAPTURE } = require('../../shared/config');

// ── PowerShell worker (primary) ──────────────────────────────────────────────
let worker  = null;
let pending = null;
let workerFails  = 0;
let workerBroken = false;   // flips true only after repeated worker failures

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

// ── Native capture (fallback) ────────────────────────────────────────────────
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

// ── Public API ───────────────────────────────────────────────────────────────
async function captureScreenshot(quality) {
  if (!workerBroken) {
    try {
      const shot = await captureViaWorker(quality);
      workerFails = 0;
      return shot;
    } catch (e) {
      // "already in progress" is a caller-side race, not a worker failure.
      if (!/already in progress/i.test(e.message)) {
        workerFails++;
        console.warn(`[capture] PowerShell capture failed (${workerFails}):`, e.message);
        if (workerFails >= 3) {
          workerBroken = true;
          console.warn('[capture] PowerShell blocked, falling back to native capturer (may hitch in-game)');
        }
      } else {
        throw e;
      }
    }
  }
  return captureNative(quality);
}

function disposeWorker() {
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  pending = null;
}

module.exports = { captureScreenshot, disposeWorker };
