/**
 * Screen capture — main process only (Electron 29+).
 * Captures at 768x432, JPEG quality 40 for minimal payload (~50-80KB).
 * Returns { buffer, hash, sizeKB } for binary upload and duplicate detection.
 */

const { desktopCapturer } = require('electron');

const TARGET_W = 640;
const TARGET_H = 360;

// Sample ~100 bytes evenly from JPEG payload (skip header) to produce a fast hash
function sampleHash(buffer) {
  if (buffer.length < 200) return buffer.length.toString(16);
  const step = Math.floor((buffer.length - 100) / 100);
  let h = 0x811c9dc5;
  for (let i = 100; i < buffer.length; i += step) {
    h ^= buffer[i];
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

async function captureScreen() {
  const t0 = Date.now();

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: TARGET_W, height: TARGET_H }
  });

  const primarySource =
    sources.find(s =>
      s.name === 'Entire Screen' ||
      s.name === 'Screen 1' ||
      s.name.toLowerCase().includes('screen')
    ) || sources[0];

  if (!primarySource) throw new Error('No screen source found');

  const buffer  = primarySource.thumbnail.toJPEG(35);
  const hash    = sampleHash(buffer);
  const sizeKB  = (buffer.length / 1024).toFixed(1);

  console.log(`[capture] ${Date.now() - t0}ms, ${sizeKB}KB`);
  return { buffer, hash, sizeKB: parseFloat(sizeKB) };
}

function createCaptureWindow() {}
function getCaptureWindow() { return null; }

module.exports = { createCaptureWindow, getCaptureWindow, captureScreen, sampleHash };
