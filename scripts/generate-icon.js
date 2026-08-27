#!/usr/bin/env node
'use strict';
/**
 * Generates assets/icon.png (256x256) and assets/icon.ico (multi-size)
 * from the Occlara aperture mark, no external dependencies required.
 *
 * Usage:  node scripts/generate-icon.js
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ─── Occlara aperture (coordinate space 0 0 24 24, scaled to any size) ──────
//
// Geometry mirrors assets/logo-mark.svg exactly, converted from its 64 viewBox
// by dividing by 64/24. If that file changes, this must change with it: they are
// two hand-maintained copies of one drawing, which is precisely how the old
// ghost ended up subtly different in five places.
//
// The gaps come from the SVG's stroke-dasharray of 42.265 on 8, against a
// circumference of 2*pi*24 = 150.796. That is three dashes of 100.9 degrees
// separated by three gaps of 19.1 degrees, starting at twelve o'clock because
// the SVG carries rotate(-90).

const C = 12;              // centre, in the 24 unit space
const RING_R = 9;          // 24 / (64/24)
const RING_HALF = 0.94;    // half of stroke-width 5, converted
const PUPIL_R = 2.44;      // 6.5, converted
const GAPS = [[100.9, 120], [220.9, 240], [340.9, 360]];

// A DARK TILE, not a bare white mark. The mark is white, and a white icon
// disappears against a light desktop or a light taskbar. Every app that ships a
// monochrome mark puts it on a tile for exactly this reason.
const TILE = [0x12, 0x13, 0x16, 0xFF];
const MARK = [0xFF, 0xFF, 0xFF, 0xFF];
const CORNER_R = 5.4;      // ~22% of 24, the platform convention

/** Rounded-square tile test, so the icon has defined edges at every size. */
function isInsideTile(gx, gy) {
  const dx = Math.max(CORNER_R - gx, 0, gx - (24 - CORNER_R));
  const dy = Math.max(CORNER_R - gy, 0, gy - (24 - CORNER_R));
  return dx * dx + dy * dy <= CORNER_R * CORNER_R;
}

function isInsideMark(gx, gy) {
  const dx = gx - C, dy = gy - C;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= PUPIL_R) return true;                                  // the pupil
  if (d < RING_R - RING_HALF || d > RING_R + RING_HALF) return false;

  // Angle from twelve o'clock, clockwise, matching the SVG's rotate(-90).
  let a = Math.atan2(dx, -dy) * 180 / Math.PI;
  if (a < 0) a += 360;
  for (const [lo, hi] of GAPS) if (a >= lo && a < hi) return false;
  return true;
}

function drawMark(size) {
  const pixels = Buffer.alloc(size * size * 4, 0); // all transparent

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const gx = (px + 0.5) * 24 / size;
      const gy = (py + 0.5) * 24 / size;

      let r = 0, g = 0, b = 0, a = 0;
      if (isInsideTile(gx, gy)) [r, g, b, a] = TILE;
      if (isInsideMark(gx, gy) && isInsideTile(gx, gy)) [r, g, b, a] = MARK;

      const i = (py * size + px) * 4;
      pixels[i]     = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return pixels;
}

// ─── PNG encoder (pure Node.js, uses built-in zlib) ──────────────────────────

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

// ─── ICO encoder (embeds PNGs, Windows Vista+ PNG-in-ICO format) ─────────────

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

console.log('Generating Occlara icon...');
for (const sz of sizes) {
  pngs[sz] = encodePNG(sz, drawMark(sz));
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
