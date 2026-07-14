'use strict';

/**
 * Rolling game-audio memory. Captures Windows loopback (what the player
 * hears) at 16kHz mono into an 8-second ring buffer, and pushes the buffer
 * to main as a small WAV every 5 seconds. RAM only, never touches disk,
 * dies with this window when the session ends.
 */
const SECONDS = 8;
const RATE    = 16000;
const PUSH_EVERY_MS = 5000;

const ring = new Float32Array(SECONDS * RATE);
let writePos = 0;
let filled   = 0;

function encodeWav(samples, rate) {
  // 16-bit PCM mono WAV.
  const buf  = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}

function snapshotWavB64() {
  if (filled < RATE) return null;   // under a second captured: nothing useful yet
  const n = Math.min(filled, ring.length);
  const out = new Float32Array(n);
  // Chronological order: oldest sample first.
  const start = filled >= ring.length ? writePos : 0;
  for (let i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length];
  const wav = encodeWav(out, RATE);
  let bin = '';
  const bytes = new Uint8Array(wav);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function start() {
  try {
    // Loopback audio via the display-media handler (main supplies audio:'loopback').
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());   // audio only, no frame cost
    if (!stream.getAudioTracks().length) { console.log('[audio] no loopback track'); return; }

    const ctx = new AudioContext({ sampleRate: RATE });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    src.connect(proc);
    proc.connect(ctx.destination);   // output stays silent (zeros), keeps the node pumping
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        ring[writePos] = input[i];
        writePos = (writePos + 1) % ring.length;
      }
      filled += input.length;
    };

    setInterval(() => {
      try {
        const b64 = snapshotWavB64();
        if (b64) window.ghost.pushClip(b64);
      } catch (err) { console.error('[audio] snapshot failed:', err.message); }
    }, PUSH_EVERY_MS);
    console.log('[audio] loopback listening at', ctx.sampleRate, 'Hz');
  } catch (err) {
    // No capture permission / unsupported: audio simply adds nothing.
    console.log('[audio] capture unavailable:', err.message);
  }
}

start();
