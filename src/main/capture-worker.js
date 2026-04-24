'use strict';
const { parentPort } = require('worker_threads');
const { execFile }   = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TARGET_W = 854;
const TARGET_H = 480;
const JPEG_Q   = 50;

function capture() {
  const outputPath = path.join(os.tmpdir(), `ghostcoach_${process.pid}_${Date.now()}.jpg`);
  const escaped    = outputPath.replace(/\\/g, '\\\\');

  const psScript = `
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
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      { timeout: 4000 },
      (err) => {
        if (err) { reject(err); return; }
        try {
          const buf = fs.readFileSync(outputPath);
          fs.unlink(outputPath, () => {});
          resolve(buf.toString('base64'));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

parentPort.on('message', async () => {
  try {
    const data = await capture();
    parentPort.postMessage({ success: true, data });
  } catch (e) {
    parentPort.postMessage({ success: false, error: e.message });
  }
});
