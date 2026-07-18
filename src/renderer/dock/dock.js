'use strict';

// The ghost's eyes look toward the center of the screen from wherever the
// dock sits, so it always reads as watching the game. Pupils travel inside
// the r=8 sockets (pupil r=2.6, so 4px of safe travel; 3.6 keeps a rim).
const pupils = document.querySelectorAll('.pupil');
const MAX_TRAVEL = 3.6;

// The SVG is scaled from a 120x140 viewBox down to 30x35, so pupil travel in
// CSS pixels must be expressed in viewBox units (CSS transforms on SVG
// children operate in the user coordinate system).
function aim() {
  const cx = window.screen.width / 2;
  const cy = window.screen.height / 2;
  const gx = window.screenX + window.innerWidth / 2;
  const gy = window.screenY + window.innerHeight / 2;
  const dx = cx - gx;
  const dy = cy - gy;
  const len = Math.hypot(dx, dy);
  if (len < 40) {   // docked at dead center: just look straight ahead
    for (const p of pupils) p.style.transform = 'translate(0px, 0px)';
    return;
  }
  const ox = (dx / len) * MAX_TRAVEL;
  const oy = (dy / len) * MAX_TRAVEL;
  for (const p of pupils) p.style.transform = `translate(${ox.toFixed(2)}px, ${oy.toFixed(2)}px)`;
}

aim();
setInterval(aim, 400);   // follows the dock if it ever moves displays
