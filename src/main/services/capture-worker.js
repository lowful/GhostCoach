'use strict';

/**
 * Screen capture, runs entirely inside a Worker Thread so the main process (and
 * therefore the game) never stalls on the capture spawn or the JPEG encode.
 *
 * Primary path: GhostCoachCapture.exe, a tiny compiled helper that does the
 * fast GDI CopyFromScreen, downscales, JPEG-encodes, and writes base64 to
 * stdout, no temp files. It replaces the old powershell.exe screenshot script,
 * which was structurally identical to PowerShell Empire's Get-Screenshot and so
 * tripped Windows Defender's HackTool signature on users' machines.
 *
 * Fallback path: the PowerShell script, used only when the exe is missing (a
 * broken package). It keeps the app working but may itself be AV-flagged, which
 * is exactly why it is no longer the default.
 */
const { parentPort, workerData } = require('worker_threads');
const { execFile }   = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { CAPTURE } = require('../../shared/config');

const HELPER_EXE = (workerData && workerData.helperExe) || null;

function profileFor(quality) {
  return (CAPTURE.profiles && CAPTURE.profiles[quality]) || CAPTURE.profiles.standard;
}

// Primary: the compiled helper. base64 JPEG straight off stdout, no disk I/O.
function captureViaHelper(prof) {
  return new Promise((resolve, reject) => {
    execFile(
      HELPER_EXE,
      [String(prof.targetW), String(prof.targetH), String(prof.jpegQuality)],
      { timeout: CAPTURE.timeoutMs - 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error((stderr && String(stderr).trim()) || err.message)); return; }
        const b64 = String(stdout).trim();
        if (!b64) { reject(new Error('capture helper returned no data')); return; }
        resolve(b64);
      }
    );
  });
}

// Fallback: the legacy PowerShell script (only when the exe is absent).
function captureViaPowershell(prof) {
  const stamp   = `${process.pid}_${Date.now()}`;
  const outPath = path.join(os.tmpdir(), `ghostcoach_${stamp}.jpg`);
  const psPath  = path.join(os.tmpdir(), `ghostcoach_${stamp}.ps1`);
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

function capture(quality) {
  const prof = profileFor(quality);
  return HELPER_EXE ? captureViaHelper(prof) : captureViaPowershell(prof);
}

parentPort.on('message', async (msg) => {
  try {
    const data = await capture(msg && msg.quality);
    parentPort.postMessage({ success: true, data });
  } catch (e) {
    parentPort.postMessage({ success: false, error: e.message });
  }
});
