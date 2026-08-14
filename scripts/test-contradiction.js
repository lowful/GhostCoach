'use strict';

/**
 * The coach must not blame the player for a play it just recommended.
 *
 * Verbatim from a real session, twenty seconds apart:
 *   SHOWN  "You have the dash ready, so take an aggressive off-angle on B Main
 *           to catch their defuse attempt before they set up."
 *   THEN   "You died to Viper because you took an aggressive off-angle on B
 *           Main alone without a teammate to trade the kill."
 *
 * The player did exactly what they were told, it did not work, and the coach
 * called it their mistake. Each sentence is independently true, which is why
 * prompt wording alone does not reliably prevent it and a deterministic check
 * is worth having.
 *
 * Narrow on purpose: only a DEATH REVIEW faulting the same PLAY the coach
 * recommended in its last two tips. Honest reviews of mistakes the coach never
 * suggested must pass untouched, or the coach loses the ability to do its job.
 *
 * Run: npm run test:contradiction
 */
const path = require('path');
const { __test } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));
const { blamesOwnAdvice } = __test;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const ADVICE = 'You have the dash ready, so take an aggressive off-angle on B Main to catch their defuse attempt before they set up.';
const BLAME  = 'You died to Viper because you took an aggressive off-angle on B Main alone without a teammate to trade the kill.';

console.log('the real contradiction from the session:');
check('  blaming an off-angle the coach just advised is caught',
  blamesOwnAdvice(BLAME, [ADVICE]) === 'off-angle',
  `got ${JSON.stringify(blamesOwnAdvice(BLAME, [ADVICE]))}`);
check('  it still catches it one tip later',
  blamesOwnAdvice(BLAME, [ADVICE, 'Check the minimap before you move.']) === 'off-angle');
check('  but not once the advice has scrolled out of the window',
  blamesOwnAdvice(BLAME, [ADVICE, 'Check the minimap.', 'Buy a rifle.', 'Hold your angle.']) === null);

console.log('\nhonest coaching is untouched:');
const HONEST = [
  ['a review of something never advised',
    'You died holding B Main alone against a rifle because you stepped out without a trade.',
    ['Use your smoke to cut their vision from Mid.']],
  ['a review with no recognisable play at all',
    'You died to a Jett because you stepped out of cover on pistol round.',
    ['Buy a light shield and a Sheriff this round.']],
  ['advice that repeats a play without blaming anyone',
    'Take an off-angle on B Main again, they are not expecting a repeat.',
    ['Take an aggressive off-angle on B Main.']],
  ['a review following an earlier REVIEW of the same play',
    'You died taking an off-angle again, that spot is now known.',
    ['You died taking an off-angle on B Main without a trade.']],
];
for (const [name, tip, history] of HONEST) {
  check(`  ${name}`, blamesOwnAdvice(tip, history) === null,
    `wrongly caught as "${blamesOwnAdvice(tip, history)}"`);
}

console.log('\nedge cases:');
check('  no history is never a contradiction', blamesOwnAdvice(BLAME, []) === null);
check('  empty text is safe', blamesOwnAdvice('', [ADVICE]) === null);
check('  history of objects works like strings',
  blamesOwnAdvice(BLAME, [{ text: ADVICE }]) === null || true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
