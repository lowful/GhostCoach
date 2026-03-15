/**
 * Screen capture — main process only (Electron 29+).
 * Captures directly at 960x540 and uses JPEG quality 40 for minimal payload.
 */

const { desktopCapturer } = require('electron');

const TARGET_W = 960;
const TARGET_H = 540;

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

  const jpegBuffer = primarySource.thumbnail.toJPEG(40);
  const b64 = jpegBuffer.toString('base64');

  console.log('[capture] took ' + (Date.now() - t0) + 'ms');
  return b64;
}

function createCaptureWindow() {}
function getCaptureWindow() { return null; }

module.exports = { createCaptureWindow, getCaptureWindow, captureScreen };
