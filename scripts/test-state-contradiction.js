'use strict';

/**
 * A tip must not assert something the app has already counted otherwise.
 *
 * Both cases below reached a real player in one session:
 *
 *   "You are last alive on defense"                with THREE teammates alive
 *   "last alive in a 1v5, use the spike timer"     during the BUY PHASE
 *
 * Neither is bad advice. Both are advice about a round that is not happening,
 * which is worse: it is specific, confident and instantly checkable, so the
 * player knows at a glance that the coach is not watching. This is the same
 * principle as HP beats death, applied to the counts: when a sentence
 * contradicts a number the app already read off the screen, the number wins.
 *
 * The refusals matter as much as the catches. A missing count means the app
 * does not know, and not knowing is never grounds for throwing away a tip.
 *
 * Run: npm run test:statecontradiction
 */
const path = require('path');
const { __test } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));
const { contradictsState } = __test;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

console.log('the two tips that actually shipped:');
const realA = 'You are last alive on defense, so hold your current angle tight and let them push into you rather than chasing a kill.';
check('  "last alive" with 3 teammates up is caught',
  !!contradictsState(realA, { teammatesAlive: 3, phase: 'postplant' }),
  contradictsState(realA, { teammatesAlive: 3, phase: 'postplant' }) || 'not caught');

const realB = 'You are last alive in a 1v5 clutch, so isolate one enemy at a time and use the spike timer to force their mistakes rather than chasing kills.';
check('  a clutch during the buy phase is caught',
  !!contradictsState(realB, { teammatesAlive: 0, phase: 'buy' }),
  contradictsState(realB, { teammatesAlive: 0, phase: 'buy' }) || 'not caught');
check('  and the reason names the buy phase',
  /buy phase/i.test(contradictsState(realB, { teammatesAlive: 0, phase: 'buy' }) || ''));

console.log('\nthe spike cannot be referenced before it exists:');
check('  "spike timer" in buy is caught',
  !!contradictsState('Use the spike timer to bait their rotation.', { phase: 'buy' }));
check('  "post-plant" in buy is caught',
  !!contradictsState('Set up your post-plant angles now.', { phase: 'buy' }));
check('  but the same tip is fine post-plant',
  contradictsState('Use the spike timer to bait their rotation.', { phase: 'postplant' }) === null);

console.log('\nA REAL CLUTCH IS STILL ALLOWED, which is the point:');
check('  last alive with 0 teammates, mid round',
  contradictsState(realA, { teammatesAlive: 0, phase: 'active' }) === null,
  'a genuine clutch call is the most valuable tip in the game');
check('  1v3 with 0 teammates',
  contradictsState('You are in a 1v3, take them one at a time.', { teammatesAlive: 0, phase: 'active' }) === null);

console.log('\nit never rejects on a missing count:');
check('  unknown teammate count', contradictsState(realA, { phase: 'active' }) === null,
  'not knowing is not the same as knowing otherwise');
check('  unknown phase', contradictsState('Use the spike timer now.', {}) === null);
check('  no context at all', contradictsState(realA, null) === null);
check('  empty text', contradictsState('', { teammatesAlive: 3 }) === null);

// ── Telling a living player they are dead ────────────────────────────────────
//
// claimsNotAlive existed, with both regexes written and working, and NOTHING
// CALLED IT. verifyTip returned "You died holding that angle, reset next round."
// unchanged to a player at 100 HP in an active round.
//
// The refusals in this block matter more than the catches. Deaths that looked
// fabricated turned out to be real (see test-alive-claims), and the guard built
// on that mistake suppressed correct death reviews. So this fires only on
// affirmative evidence of being alive with no death under review.
console.log('\na living player must not be told they are dead:');
const aliveCtx = { playerAlive: true, playerHp: 100, phase: 'active', teammatesAlive: 3 };
for (const t of [
  'You died holding that angle, reset next round.',
  'You got traded there, so play closer to your team.',
  "You're dead, so watch the killcam for their position.",
  'You are spectating, so watch how they clear the site.',
]) {
  const why = contradictsState(t, aliveCtx);
  check(`  "${t.slice(0, 46)}..." is caught`, !!why, why || 'not caught');
}
check('  and the reason states the health it was told',
  /100 HP/.test(contradictsState('You died there, reset next round.', aliveCtx) || ''));
check('  a readable health number alone is enough',
  !!contradictsState('You died there, reset next round.', { playerHp: 74, phase: 'active' }));

console.log('\nBUT A REAL DEATH REVIEW MUST SURVIVE, which is the whole risk here:');
const deathReview = 'You died holding B Market alone without a trade partner, so reset next round.';
check('  while dead by the alive flag',
  contradictsState(deathReview, { playerAlive: false, phase: 'dead' }) === null);
check('  while the phase says dead',
  contradictsState(deathReview, { phase: 'dead', playerHp: 100 }) === null,
  'a spectated teammate\'s health must not unlock the rejection');
check('  just respawned, inside the review window',
  contradictsState(deathReview, { playerAlive: true, playerHp: 100, phase: 'buy', lastDeathAt: Date.now() - 3000 }) === null,
  'the review of the death that just happened is the most valuable tip there is');
check('  spectating claim while genuinely spectating',
  contradictsState('You are spectating, so watch their rotation.', { playerAlive: false, phase: 'dead' }) === null);
check('  alive state unknown',
  contradictsState(deathReview, { phase: 'active', teammatesAlive: 3 }) === null,
  'not knowing is not the same as knowing otherwise');
check('  hp 0 is not alive',
  contradictsState(deathReview, { playerHp: 0, phase: 'active' }) === null);
check('  a tip about a TEAMMATE dying is not a claim about the player',
  contradictsState('Trade your teammate when they die instead of holding.', aliveCtx) === null);

console.log('\nordinary tips are untouched:');
for (const t of [
  'Hold A Link tight until your team commits, then take the angle.',
  'You died holding B Market alone without a trade partner, so reset next round.',
  'Check the minimap before you take space, three are showing B.',
  'Your team is stacked A, so play the flank rather than following them in.',
]) {
  check(`  "${t.slice(0, 52)}..."`,
    contradictsState(t, { teammatesAlive: 3, phase: 'active', spike: null }) === null,
    contradictsState(t, { teammatesAlive: 3, phase: 'active' }) || '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
