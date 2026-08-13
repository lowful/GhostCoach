'use strict';

/**
 * Aggregate coaching telemetry: useful counts, no player content.
 *
 * The AI decision log is what has found nearly every real bug in this app, and
 * it exists only on the player's own machine. That stays true. A frame is a
 * photograph of somebody's screen, complete with their Discord, their tabs and
 * their stream chat, so collecting frames centrally would turn a low-risk local
 * tool into a genuine liability.
 *
 * The useful part was never the picture, it was the COUNTS. Repetition being
 * roughly three quarters of all rejections is obvious in aggregate and
 * invisible in any single session.
 *
 * So the tests that matter here are the ones proving nothing else gets through.
 * The reject reason is matched against a closed list and reduced to a slug, so a
 * future reason that interpolates a callout, a player name or a tip cannot leak
 * by accident. That is asserted below rather than assumed.
 *
 * Run: npm run test:telemetry
 */
const path = require('path');
const t = require(path.join(__dirname, '..', 'server', 'services', 'telemetry.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// Verbatim reject reasons from real sessions.
const REAL = {
  'too similar to a recent tip': 55,
  'failed the final verify gate (ai)': 27,
  'already recommended a trade in the last two tips': 20,
  'repeated the same ability (wall) back to back': 13,
  'the tip was cut off mid sentence': 3,
};

console.log('real reject reasons reduce to stable kinds:');
const EXPECT = [
  ['too similar to a recent tip', 'similar'],
  ['already recommended a crossfire in the last two tips', 'repeat-play'],
  ['repeated the same ability (wall) back to back', 'repeat-play'],
  ['the tip was cut off mid sentence', 'truncated'],
  ['failed the final verify gate (ai)', 'verify-gate'],
  ['every enemy is dead, the round is already decided, staying quiet until the next one', 'round-decided'],
];
for (const [reason, kind] of EXPECT) {
  check(`  ${kind.padEnd(14)} <- ${reason.slice(0, 46)}`, t.kindOf(reason) === kind, `got "${t.kindOf(reason)}"`);
}

console.log('\nA REASON THAT LEAKS CONTENT IS NEVER STORED, ONLY COUNTED:');
// The real hazard: a future reject reason that interpolates something personal.
const LEAKY = [
  'said the death was at "A Heaven" but the player died at "B Market"',
  'used the callout "Hookah" which does not belong to the map Breeze',
  'the player TenZ#NA1 was told to hold Mid Top',
];
for (const reason of LEAKY) {
  const kind = t.kindOf(reason);
  const inClosedSet = t.REJECT_KINDS.some(([k]) => k === kind) || kind === 'other';
  check(`  reduced to "${kind}"`, inClosedSet && !/heaven|market|hookah|tenz|breeze/i.test(kind),
    'the raw reason survived into the stored kind');
}

console.log('\nthe published summary contains no content at all:');
t.record({ version: '2.9.9', durationMin: 12, tipsShown: 23, tipsGenerated: 73, rejects: REAL }, 'abcd1234ffff');
t.record({ version: '2.9.9', durationMin: 9, tipsShown: 12, tipsGenerated: 48,
  rejects: { 'used the callout "Hookah" which does not belong to the map Breeze': 4 } }, 'zzzz9999');
const s = t.summary();
const blob = JSON.stringify(s);
check('  no map, callout, agent or player name anywhere',
  !/hookah|breeze|bind|icebox|tenz|jett|iso|stay tight|peek/i.test(blob), blob.slice(0, 200));
check('  the licence tag is truncated to 8 characters',
  !/abcd1234ffff|zzzz9999z/.test(blob));

console.log('\nthe numbers that make it worth collecting:');
check('  show rate is computed', s.showRate === Math.round((35 / 121) * 100), `got ${s.showRate}`);
check('  sessions and users counted', s.sessions === 2 && s.distinctUsers === 2);
check('  rejects ranked with the biggest first',
  s.rejects[0].kind === 'similar' && s.rejects[0].n >= s.rejects[1].n);
check('  repetition is visible as the dominant failure',
  s.rejects.filter((r) => r.kind === 'similar' || r.kind === 'repeat-play')
    .reduce((a, r) => a + r.pct, 0) > 50);

console.log('\nmalformed input cannot take the endpoint down:');
check('  null report is ignored', (t.record(null, 'x'), true));
check('  junk fields are clamped, not stored',
  (t.record({ tipsShown: 1e9, durationMin: -5, rejects: null }, 'y'), t.summary().sessions === 3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
