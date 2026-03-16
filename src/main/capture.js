/**
 * Screen capture — PowerShell child process (zero game impact).
 * Falls back to desktopCapturer if PowerShell fails.
 * Returns { buffer, hash, sizeKB }.
 */

'use strict';
const { execFile }        = require('child_process');
const { desktopCapturer } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const TARGET_W = 640;
const TARGET_H = 360;
const JPEG_Q   = 35;
const TMP_PATH = path.join(os.tmpdir(), 'ghostcoach_capture.jpg');

// FNV-1a hash of ~100 evenly sampled bytes
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

// ─── PowerShell capture (separate process — no main thread block) ──────────────
function captureViaPowerShell() {
  const escaped = TMP_PATH.replace(/\\/g, '\\\\');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$s = [System.Windows.Forms.Screen]::PrimaryScreen
$bmp = New-Object System.Drawing.Bitmap($s.Bounds.Width, $s.Bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($s.Bounds.Location, [System.Drawing.Point]::Empty, $s.Bounds.Size)
$r = New-Object System.Drawing.Bitmap($bmp, ${TARGET_W}, ${TARGET_H})
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${JPEG_Q})
$r.Save('${escaped}', $enc, $ep)
$g.Dispose(); $bmp.Dispose(); $r.Dispose()
`;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000 },
      (err) => {
        if (err) { reject(err); return; }
        try {
          const buffer = fs.readFileSync(TMP_PATH);
          resolve(buffer);
        } catch (e) { reject(e); }
      }
    );
  });
}

// ─── Fallback: desktopCapturer ─────────────────────────────────────────────────
async function captureViaDesktopCapturer() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: TARGET_W, height: TARGET_H }
  });
  const src =
    sources.find(s =>
      s.name === 'Entire Screen' ||
      s.name === 'Screen 1' ||
      s.name.toLowerCase().includes('screen')
    ) || sources[0];
  if (!src) throw new Error('No screen source found');
  return src.thumbnail.toJPEG(JPEG_Q);
}

// ─── Main export ───────────────────────────────────────────────────────────────
async function captureScreen() {
  const t0 = Date.now();

  let buffer;
  try {
    buffer = await captureViaPowerShell();
  } catch (err) {
    console.warn('[capture] PowerShell failed, using desktopCapturer fallback:', err.message);
    buffer = await captureViaDesktopCapturer();
  }

  const hash   = sampleHash(buffer);
  const sizeKB = (buffer.length / 1024).toFixed(1);
  console.log(`[capture] ${Date.now() - t0}ms, ${sizeKB}KB`);
  return { buffer, hash, sizeKB: parseFloat(sizeKB) };
}

function createCaptureWindow() {}
function getCaptureWindow() { return null; }

module.exports = { createCaptureWindow, getCaptureWindow, captureScreen, sampleHash };
