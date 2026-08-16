'use strict';

/**
 * Composition arithmetic for Marvel Rivals draft coaching.
 *
 * The whole point of doing this in code is that the model cannot count. Asked
 * to read six portraits and reason about them, it will confidently tell a team
 * with three Vanguards that it needs a Vanguard. That failure is the hero
 * shooter version of naming a callout from the wrong map, and it is why the
 * Valorant coach ended up with deterministic guards in the first place.
 *
 * The most important cases here are the REFUSALS. A draft read from a
 * screenshot is regularly short a player or carries one unreadable role, and
 * advising on a miscounted roster produces advice that is specific, confident
 * and about a team that does not exist.
 *
 * Run: npm run test:rivalscomp
 */
const path = require('path');
const comp = require(path.join(__dirname, '..', 'src', 'shared', 'rivals-comp.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const V = 'Vanguard', D = 'Duelist', S = 'Strategist';

console.log('role names are read however the model writes them:');
for (const [input, want] of [
  ['Vanguard', V], ['vanguard', V], ['tank', V],
  ['Duelist', D], ['DPS', D], ['damage', D],
  ['Strategist', S], ['support', S], ['healer', S],
  ['strategists', S],
]) check(`  "${input}" -> ${want}`, comp.normaliseRole(input) === want, `got ${comp.normaliseRole(input)}`);
check('  nonsense is not guessed at', comp.normaliseRole('flanker') === null);

console.log('\nthe meta split is recognised:');
const ideal = comp.analyseComp([V, V, D, D, S, S]);
check('  2-2-2 is ideal', ideal && ideal.verdict === 'ideal', JSON.stringify(ideal));
check('  and it does not invent a problem', ideal && ideal.missing.length === 0);

console.log('\na missing role is called broken, whatever else is going on:');
const noSupport = comp.analyseComp([V, V, D, D, D, D]);
check('  zero Strategists', noSupport && noSupport.verdict === 'broken');
check('  and the advice names the real cost',
  noSupport && /healed/i.test(noSupport.advice), noSupport && noSupport.advice);
const noTank = comp.analyseComp([D, D, D, D, S, S]);
check('  zero Vanguards', noTank && noTank.verdict === 'broken' && /front line/i.test(noTank.advice));
const noDamage = comp.analyseComp([V, V, V, S, S, S]);
check('  zero Duelists', noDamage && noDamage.verdict === 'broken');

console.log('\nstacking is flagged without being called broken:');
const stacked = comp.analyseComp([V, D, D, D, D, S]);
check('  four Duelists is stacked, not broken',
  stacked && stacked.verdict === 'stacked' && stacked.ok === true, JSON.stringify(stacked));
const workable = comp.analyseComp([V, V, V, D, D, S]);
check('  3-2-1 is workable', workable && workable.verdict === 'workable' && workable.ok === true);

console.log('\nIT REFUSES TO JUDGE A ROSTER IT CANNOT TRUST:');
check('  five players is not a team', comp.analyseComp([V, V, D, D, S]) === null,
  'advising on a miscounted roster is confident nonsense');
check('  seven players is not a team', comp.analyseComp([V, V, D, D, S, S, S]) === null);
check('  one unreadable role poisons the read',
  comp.analyseComp([V, V, D, D, S, 'unknown']) === null,
  'the sixth player might be the Strategist the advice says is missing');
check('  an empty roster is refused', comp.analyseComp([]) === null);
check('  garbage input is refused', comp.analyseComp(null) === null);

console.log('\na recommended pick is sanity checked before it reaches the player:');
check('  filling an empty role always helps', comp.pickHelps([V, V, D, D, D], S) === true);
check('  a third Duelist does not', comp.pickHelps([V, V, D, D, S], D) === false);
check('  a second Vanguard does', comp.pickHelps([V, D, D, S, S], V) === true);
check('  an unreadable pick gets no opinion', comp.pickHelps([V, V, D, D, S], 'flanker') === null);
check('  an untrustworthy roster gets no opinion',
  comp.pickHelps([V, V, D, D, 'unknown'], S) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
