'use strict';

/**
 * Every getElementById in a surface must find an element in that surface.
 *
 * This is the renderer's version of the channel-name drift the IPC rule exists
 * to prevent. getElementById returns null for a typo, the listener is never
 * attached, and the control just does nothing when clicked. No error, no log
 * line, and it looks like a backend problem.
 *
 * Each renderer folder is checked against its own index.html, because these
 * surfaces do not share a DOM.
 *
 * Run: npm run check:dom
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
let problems = 0;

// Ids created at runtime rather than written into the markup. Anything listed
// here must be genuinely built in JS, not merely missing.
const RUNTIME_IDS = new Set([]);

for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory() || dir.name === 'shared') continue;
  const folder = path.join(ROOT, dir.name);
  const htmlPath = path.join(folder, 'index.html');
  if (!fs.existsSync(htmlPath)) continue;

  const html = fs.readFileSync(htmlPath, 'utf8');
  const present = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));

  for (const f of fs.readdirSync(folder).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(folder, f), 'utf8');
    const wanted = [...src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const id of new Set(wanted)) {
      if (!present.has(id) && !RUNTIME_IDS.has(id)) {
        problems++;
        console.log(`MISSING  #${id}`);
        console.log(`    wanted by ${dir.name}/${f}, not in ${dir.name}/index.html`);
      }
    }
  }
}

console.log(problems ? `\nFAIL: ${problems} element(s) referenced but never rendered`
  : '\nPASS: every getElementById target exists in its own surface');
process.exit(problems ? 1 : 0);
