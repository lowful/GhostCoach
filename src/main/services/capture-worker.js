'use strict';

/**
 * Screen capture, runs entirely inside a Worker Thread so the main process (and
 * therefore the game) never stalls on the PowerShell spawn or the JPEG encode.
 * Captures the primary screen, scales it down, JPEG-encodes, returns base64.
 */
const { parentPort } = require('worker_threads');
const { execFile }   = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { CAPTURE } = require('../../shared/config');

function capture(quality) {
  const prof    = (CAPTURE.profiles && CAPTURE.profiles[quality]) || CAPTURE.profiles.standard;
  const stamp   = `${process.pid}_${Date.now()}`;
  const outPath = path.join(os.tmpdir(), `ghostcoach_${stamp}.jpg`);
  const psPath  = path.join(os.tmpdir(), `ghostcoach_${stamp}.ps1`);

  // Executed from a .ps1 file via -File rather than an inline -Command string:
  // the inline form trips Windows Defender/AMSI's screen-scraper heuristic
  // ("malicious content"), file execution is far more reliable.
  const ps =
    'Add-Type -AssemblyName System.Windows.Forms\n' +
    'Add-Type -AssemblyName System.Drawing\n' +
    '$s = [System.Windows.Forms.Screen]::PrimaryScreen\n' +
    '$bmp = New-Object System.Drawing.Bitmap($s.Bounds.Width, $s.Bounds.Height)\n' +
    '$g = [System.Drawing.Graphics]::FromImage($bmp)\n' +
    '$g.CopyFromScreen($s.Bounds.Location, [System.Drawing.Point]::Empty, $s.Bounds.Size)\n' +
    `$r = New-Object System.Drawing.Bitmap($bmp, ${prof.targetW}, ${prof.targetH})\n` +
    "$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }\n" +
    '$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)\n' +
    `$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${prof.jpegQuality})\n` +
    `$r.Save('${outPath.replace(/\\/g, '\\\\')}', $enc, $ep)\n` +
    '$g.Dispose(); $bmp.Dispose(); $r.Dispose()\n';

  return new Promise((resolve, reject) => {
    fs.writeFile(psPath, ps, (writeErr) => {
      if (writeErr) { reject(writeErr); return; }
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psPath],
        { timeout: CAPTURE.timeoutMs - 1000, windowsHide: true },
        (err) => {
          fs.unlink(psPath, () => {});
          if (err) { reject(err); return; }
          try {
            const buf = fs.readFileSync(outPath);
            fs.unlink(outPath, () => {});
            resolve(buf.toString('base64'));
          } catch (e) { reject(e); }
        }
      );
    });
  });
}

parentPort.on('message', async (msg) => {
  try {
    const data = await capture(msg && msg.quality);
    parentPort.postMessage({ success: true, data });
  } catch (e) {
    parentPort.postMessage({ success: false, error: e.message });
  }
});
