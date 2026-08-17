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
