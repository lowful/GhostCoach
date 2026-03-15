#!/usr/bin/env node
'use strict';
/**
 * Generates assets/icon.png (256x256) and assets/icon.ico (multi-size)
 * from the GhostCoach ghost shape — no external dependencies required.
 *
 * Usage:  node scripts/generate-icon.js
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ─── Ghost shape (SVG viewBox 0 0 24 24, scaled to any size) ─────────────────

function isInsideGhost(gx, gy) {
  // Upper dome — ellipse centred at (12, 11), rx=9, ry=9 (top half only)
  if (gy <= 11) {
    return ((gx - 12) / 9) ** 2 + ((gy - 11) / 9) ** 2 <= 1;
  }

  // Lower body — rectangle x:[3,21], y:[11,waveBottom]
  if (gx < 3 || gx > 21) return false;

  // Wavy bottom: l3-3 3 3 3-3 3 3 3-3 starting from (3,22)
  // 6 segments each 3 SVG-units wide alternating valley(22)→peak(19)
  const t   = (gx - 3) / 3;
  const seg = Math.min(Math.floor(t), 5);
  const frac = t - seg;
  const startY = (seg % 2 === 0) ? 22 : 19;
  const endY   = (seg % 2 === 0) ? 19 : 22;
  const waveY  = startY + (endY - startY) * frac;

  return gy <= waveY;
}

function isInsideEye(gx, gy) {
  // Left eye centred at (9.5, 10.5), r=1.5
  if ((gx - 9.5) ** 2 + (gy - 10.5) ** 2 <= 1.5 ** 2) return true;
  // Right eye centred at (14.5, 10.5), r=1.5
  if ((gx - 14.5) ** 2 + (gy - 10.5) ** 2 <= 1.5 ** 2) return true;
  return false;
}

function drawGhost(size) {
  const pixels = Buffer.alloc(size * size * 4, 0); // all transparent

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const gx = (px + 0.5) * 24 / size;
      const gy = (py + 0.5) * 24 / size;

      let r = 0, g = 0, b = 0, a = 0;

      if (isInsideGhost(gx, gy)) {
        r = 0xFF; g = 0x46; b = 0x55; a = 0xFF; // #FF4655
      }
      if (isInsideEye(gx, gy)) {
        r = 0x0F; g = 0x19; b = 0x23; a = 0xFF; // #0F1923 (dark)
      }

      const i = (py * size + px) * 4;
      pixels[i]     = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return pixels;
}

// ─── PNG encoder (pure Node.js — uses built-in zlib) ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function computeCRC(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBytes  = Buffer.alloc(4);
  lenBytes.writeUInt32BE(data.length);
  const crcVal  = computeCRC(Buffer.concat([typeBytes, data]));
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crcVal);
  return Buffer.concat([lenBytes, typeBytes, data, crcBytes]);
}

function encodePNG(size, pixels) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA

  // Raw scanlines: 1 filter byte + 4 bytes per pixel
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: None
    pixels.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ─── ICO encoder (embeds PNGs — Windows Vista+ PNG-in-ICO format) ────────────

function encodeICO(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const dirHeader = Buffer.alloc(6);
  dirHeader.writeUInt16LE(0, 0); // reserved
  dirHeader.writeUInt16LE(1, 2); // type: icon
  dirHeader.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const entries = [];

  for (let i = 0; i < count; i++) {
    const entry = Buffer.alloc(16);
    const sz = sizes[i];
    entry[0] = sz >= 256 ? 0 : sz;  // 0 means 256 in ICO spec
    entry[1] = sz >= 256 ? 0 : sz;
    entry[2] = 0;   // colour count
    entry[3] = 0;   // reserved
    entry.writeUInt16LE(1,  4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(pngBuffers[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngBuffers[i].length;
    entries.push(entry);
  }

  return Buffer.concat([dirHeader, ...entries, ...pngBuffers]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256];
const pngs  = {};

console.log('Generating ghost icon…');
for (const sz of sizes) {
  pngs[sz] = encodePNG(sz, drawGhost(sz));
  console.log(`  ${sz}x${sz} done`);
}

// 256×256 PNG for tray icon
fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngs[256]);
console.log('✓ assets/icon.png');

// Multi-size ICO for Windows installer & taskbar
const icoSizes = [16, 32, 48, 256];
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), encodeICO(icoSizes.map(s => pngs[s]), icoSizes));
console.log('✓ assets/icon.ico');

console.log('\nDone! Run "npm run dist:win" to rebuild the installer.');
