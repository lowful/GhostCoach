'use strict';

/**
 * Text defects that reached a player mid match.
 *
 * All three are verbatim from one session. None were caught, because each slips
 * past a guard that was looking somewhere else:
 *
 *   - the shouting is grammatically perfect, so no sentence check objects
 *   - "WITH your, AND HOLD" ends the sentence properly, and the truncation
 *     check only inspects the LAST word, so a noun dropped mid sentence is
 *     invisible to it
 *   - "you are lone" is a real word in the wrong place, so no spell rule fires
 *
 * Shouting and the typo are NORMALISED rather than rejected: the coaching is
 * fine and dropping it would cost a real tip over a formatting slip. The broken
 * fragment IS rejected, because there is no honest way to guess the missing word.
 *
 * Run: npm run test:tiptext
 */
const path = require('path');
const { __test } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));
const { verifyTip } = __test;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};
const ctx = { map: 'Sunset', agent: 'Iso', agentConfirmed: true, playerAlive: true, playerHp: 100 };
const run = (t) => verifyTip(t, 'ai', ctx);

console.log('shouting is turned back into a sentence, not thrown away:');
const SHOUT = 'SET UP A CROSSFIRE AT B MAIN SO THE FIRST ENTRY GETS TRADED.';
const fixed = run(SHOUT);
check('  the tip survives', !!fixed, 'it was rejected, which loses real coaching');
check('  it is no longer all capitals', fixed && !/[A-Z]{6,}/.test(fixed), fixed);
check('  the site letter is preserved', fixed && /\bB Main\b/.test(fixed), fixed);

console.log('\na dropped noun mid sentence is rejected:');
const FRAGMENT = 'SET UP A CROSSFIRE ON A SITE WITH your, AND HOLD AN OFF-ANGLE IN MID TO CUT THEIR FLANK IF THEY RUSH.';
check('  "with your," does not reach the player', run(FRAGMENT) === null,
  `it returned: ${run(FRAGMENT)}`);
check('  so does "hold the, and rotate"',
  run('Hold the, and rotate through mid when your team commits.') === null);

console.log('\nthe "lone" typo is corrected:');
const LONE = run('You are lone in B Lobby while four teammates hold A, so wait for a rotation.');
check('  reads "you are alone"', !!LONE && /you are alone/i.test(LONE), LONE);

console.log('\nordinary tips are left exactly as they are:');
const KEEP = [
  'Hold A Link tight until your team commits, then push through with Double Tap.',
  'You died holding B Market alone without a trade partner, so reset next round.',
  'Set up a crossfire at B Main so the first entry gets traded.',
];
for (const t of KEEP) {
  const out = run(t);
  check(`  "${t.slice(0, 46)}..."`, out === t, `changed to: ${out}`);
}

console.log('\nshort capitalised callouts are not treated as shouting:');
for (const t of ['Hold B Main tight and let them cross into you.',
  'Rotate to A now, the spike is down.',
  'Rotate through mid now, they are committed to B.']) {
  const out = run(t);
  check(`  "${t.slice(0, 42)}..."`, out === t, `changed to: ${out}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
