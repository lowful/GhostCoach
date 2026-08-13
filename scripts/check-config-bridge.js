'use strict';

/**
 * Every setting the renderer can WRITE must be readable back.
 *
 * setConfig persists whatever key it is handed, but the renderer's only view of
 * the config is snapshotConfig(), which is an explicit field list. A key missing
 * from that list is written to disk and then invisible, and nothing anywhere
 * throws.
 *
 * That is exactly how the language setting broke. Choosing a language saved
 * correctly and the coaching tips followed it, because the engine reads the
 * store directly. But Settings read cfg.language as undefined and reset the
 * picker to English every time it opened, and initI18n resolved English on
 * every refresh so no window ever repainted. The app coached in German and
 * looked entirely English, and the Save button appeared to do nothing.
 *
 * Run: npm run check:config
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let problems = 0;

// Keys the renderer actually writes, read straight out of the surfaces.
const written = new Map();
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
for (const f of walk(path.join(ROOT, 'renderer'))) {
  const src = fs.readFileSync(f, 'utf8');
  // setConfig({ key: ... }) and setConfig({ key })
  for (const m of src.matchAll(/setConfig\(\s*\{([^}]*)\}/g)) {
    for (const km of m[1].matchAll(/([a-zA-Z_][\w]*)\s*:/g)) {
      if (!written.has(km[1])) written.set(km[1], path.relative(ROOT, f));
    }
  }
}

// Keys snapshotConfig hands back.
const ipcSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'register-ipc.js'), 'utf8');
const snap = ipcSrc.match(/function snapshotConfig\(\)\s*\{([\s\S]*?)\n\}/);
if (!snap) {
  console.log('FAIL: snapshotConfig() not found');
  process.exit(1);
}
const exposed = new Set([...snap[1].matchAll(/^\s*([a-zA-Z_][\w]*):/gm)].map((m) => m[1]));

console.log(`renderer writes ${written.size} config keys; snapshotConfig exposes ${exposed.size}\n`);
for (const [key, where] of written) {
  if (!exposed.has(key)) {
    problems++;
    console.log(`WRITE-ONLY  ${key}`);
    console.log(`    set by ${where}, never returned by snapshotConfig()`);
    console.log('    the renderer cannot read it back, so the setting will not stick');
  }
}

console.log(problems
  ? `\nFAIL: ${problems} setting(s) can be saved but never read back`
  : '\nPASS: every setting the renderer writes is readable back');
process.exit(problems ? 1 : 0);
