'use strict';

/**
 * Prove the backend can load with server/ as its ROOT, which is how Railway
 * deploys it.
 *
 * A require reaching up into src/ resolves perfectly on a dev machine and is
 * MODULE_NOT_FOUND in production, so it does not fail a test, it crash-loops
 * the container on boot and takes the whole backend down. That happened, and
 * nothing in the repo would have caught it.
 *
 * Two checks:
 *   1. No file under server/ requires a path that escapes server/.
 *   2. Every server module actually loads.
 *
 * Run: npm run check:server
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'server');
let problems = 0;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log(`checking ${files.length} server files\n`);

// 1. Relative requires must stay inside server/.
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!target.startsWith(ROOT)) {
      problems++;
      console.log(`ESCAPES server/  ${path.relative(ROOT, f)}`);
      console.log(`    require('${m[1]}') resolves outside the deploy root`);
    }
  }
}

// 2. Everything loads. Catches a typo'd path or a missing dependency that a
// syntax check alone would miss.
for (const f of files) {
  try {
    require(f);
  } catch (e) {
    // A module that needs env vars or a port at import time is not what this is
    // looking for; a missing module is.
    if (e && e.code === 'MODULE_NOT_FOUND') {
      problems++;
      console.log(`WILL NOT LOAD    ${path.relative(ROOT, f)}`);
      console.log(`    ${e.message.split('\n')[0]}`);
    }
  }
}

console.log(problems ? `\nFAIL: ${problems} problem(s)` : '\nPASS: server/ is self contained and loads');
process.exit(problems ? 1 : 0);
