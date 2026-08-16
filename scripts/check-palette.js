'use strict';

/**
 * Brand colours must go through tokens, or a re-skin changes almost nothing.
 *
 * `theme.css` was always well designed and always under-adopted: 51 copies of
 * the brand red and 68 of the cyan had been written out longhand as `rgba(255,
 * 70, 85, …)` across 15 surface stylesheets. `panel.css` was the clearest case,
 * zero hex values yet sixteen literal cyans, so it looked perfectly clean while
 * being hardcoded to the Valorant palette.
 *
 * Nothing failed, which is the problem. The app rendered correctly and the
 * damage only appeared when you tried to change the palette and watched most of
 * the interface ignore you.
 *
 * Status colours are checked too, but for the opposite reason: `--good`,
 * `--bad` and `--warn` describe an outcome rather than a brand, so they must
 * stay constant across games. They are tokens so that a palette swap CANNOT
 * accidentally recolour a win.
 *
 * Run: npm run check:palette
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const THEME = path.join(ROOT, 'shared', 'theme.css');

// The definitions live in theme.css, so it is the one file allowed literals.
const BANNED = [
  ['brand red',   /rgba\(\s*255\s*,\s*70\s*,\s*85\s*,/g,   'rgba(var(--red-rgb), …)'],
  ['brand cyan',  /rgba\(\s*0\s*,\s*240\s*,\s*255\s*,/g,   'rgba(var(--cyan-rgb), …)'],
  ['brand red',   /#FF4655\b/gi,                            'var(--red)'],
  ['brand cyan',  /#00F0FF\b/gi,                            'var(--cyan)'],
  ['status good', /#4fd394\b/gi,                            'var(--good)'],
  ['status bad',  /#ff9aa3\b/gi,                            'var(--bad)'],
  ['status warn', /#f5c451\b/gi,                            'var(--warn)'],
  ['status good', /rgba\(\s*79\s*,\s*211\s*,\s*148\s*,/g,   'rgba(var(--good-rgb), …)'],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.css') && p !== THEME) out.push(p);
  }
  return out;
}

let problems = 0;
for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f, 'utf8');
  for (const [label, re, fix] of BANNED) {
    const n = (src.match(re) || []).length;
    if (!n) continue;
    problems += n;
    console.log(`${String(n).padStart(3)}x literal ${label}  in ${path.relative(ROOT, f)}`);
    console.log(`     use ${fix} instead, or a palette swap will not reach it`);
  }
}

// The tokens themselves must exist, since everything above depends on them.
const theme = fs.readFileSync(THEME, 'utf8');
for (const t of ['--red-rgb', '--cyan-rgb', '--good', '--bad', '--warn', '--good-rgb']) {
  if (!new RegExp(`${t}\\s*:`).test(theme)) {
    problems++;
    console.log(`MISSING TOKEN  ${t} is not defined in shared/theme.css`);
  }
}

console.log(problems
  ? `\nFAIL: ${problems} colour(s) bypass the palette`
  : '\nPASS: every brand and status colour goes through a token');
process.exit(problems ? 1 : 0);
