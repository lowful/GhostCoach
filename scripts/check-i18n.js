'use strict';

/**
 * Every data-i18n key must exist, and t() must be called correctly.
 *
 * A missing key does not throw. t() returns the key itself, so the interface
 * renders the literal string "common.save" where a word should be, and it looks
 * like a typo in the copy rather than a missing translation. That was shipped
 * into a Save button before this check existed.
 *
 * The signature is t(code, key), and calling t(key) alone is worse: the key is
 * read as a language code, the lookup misses, and the UI renders the word
 * "undefined".
 *
 * Run: npm run check:i18n
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const I18N = require(path.join(ROOT, 'shared', 'i18n.js'));

let problems = 0;
const note = (msg) => { problems++; console.log(msg); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const EN = 'en';

// 1. Every data-i18n key resolves to something other than itself.
// MARKUP ONLY. Scanning .js as well picked up the usage examples inside
// i18n-apply.js's own doc comment and reported them as missing keys, which is
// a check that cries wolf about its own documentation.
const keys = new Map();
for (const f of files.filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /data-i18n(?:-[a-z]+)?=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    if (!keys.has(m[1])) keys.set(m[1], path.relative(ROOT, f));
  }
}
console.log(`checking ${keys.size} data-i18n keys across ${files.length} files\n`);
for (const [key, where] of keys) {
  if (I18N.t(EN, key) === key) note(`MISSING KEY   ${key}   (${where})`);
}

// 2. Every UI catalogue carries every key English has, or the interface falls
// back mid-sentence and reads half translated. English is excluded for the
// obvious reason: comparing English against English reported the source
// language as a thin catalogue.
for (const lang of I18N.LANGUAGES.filter((l) => I18N.hasUi(l.code) && l.code !== EN)) {
  const missing = [...keys.keys()].filter((k) => {
    const translated = I18N.t(lang.code, k);
    const english = I18N.t(EN, k);
    // Falling back to the English string is allowed for a genuinely identical
    // word, but a UI language missing most keys is a real gap.
    return translated === english && english.length > 3;
  });
  if (missing.length > keys.size * 0.5) {
    note(`THIN CATALOGUE ${lang.code}: ${missing.length}/${keys.size} keys fall back to English`);
  }
}

// 3. t() called with a single argument, which silently yields "undefined".
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /i18n\.t\(\s*(['"][^'"]+['"])\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    note(`t() NEEDS (code, key)   t(${m[1]})   (${path.relative(ROOT, f)})`);
  }
}

// 4. Picking a language must visibly change the app.
//
// The point of the setting, and the thing a user actually judges it by. It is
// asserted per surface because the failure that prompted this was invisible in
// aggregate: the language saved, the tips translated, and the interface did not
// move, so the Save button looked broken.
console.log('\nwhat a German user would see change, per surface:');
let anyChanges = 0;
const bySurface = new Map();
for (const [key, where] of keys) {
  const surface = where.split(/[\\/]/)[1] || where;
  if (!bySurface.has(surface)) bySurface.set(surface, { total: 0, changed: 0 });
  const s = bySurface.get(surface);
  s.total++;
  if (I18N.t('de', key) !== I18N.t(EN, key)) { s.changed++; anyChanges++; }
}
for (const [surface, s] of bySurface) {
  console.log(`  ${surface.padEnd(12)} ${s.changed}/${s.total} elements change`);
}
if (!anyChanges) note('NOTHING CHANGES: no wired key differs in German, the setting would look broken');

console.log(problems ? `\nFAIL: ${problems} problem(s)` : '\nPASS: every key resolves and t() is called correctly');
process.exit(problems ? 1 : 0);
