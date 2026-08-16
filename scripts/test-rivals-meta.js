'use strict';

/**
 * Hero strength, and hero strength FOR A PARTICULAR PLAYER.
 *
 * A tier list is public information any website gives away. The coach's value
 * is knowing the player averages 0.7 K/D on the S-tier pick and 1.4 on the
 * B-tier one, so the tests that matter here are the ones where the player's
 * record and the meta DISAGREE.
 *
 * Two facts from researching the live meta shape all of this:
 *
 *   1. It goes stale fast. Season 9.5 landed on 7 August 2026, nerfed the
 *      highest win rate hero in the game and added a new Vanguard. Tier data
 *      from before a patch is not old, it is confidently wrong.
 *   2. Public sources disagree. Two tier lists on the same day put the same
 *      hero at 59.1% and 56.3%. That is why bands are used and exact figures
 *      are never quoted to a player.
 *
 * Run: npm run test:rivalsmeta
 */
const path = require('path');
const meta = require(path.join(__dirname, '..', 'src', 'shared', 'rivals-meta.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const fresh = (heroes) => ({ patch: '9.5', fetchedAt: Date.now(), heroes });
const stale = (heroes) => ({ patch: '9.0', fetchedAt: Date.now() - 90 * 86400000, heroes });
// Real figures from the Season 9.5 meta, used as shapes rather than as truth.
const HEROES = {
  'Peni Parker':    { winRate: 56.3 },
  'Mantis':         { winRate: 56.0 },
  'Rocket Raccoon': { winRate: 56.5 },
  'Iron Man':       { winRate: 50.2 },
  'Jubilee':        { winRate: 45.1 },
};

console.log('win rates are read as bands, because sources disagree by three points:');
check('  56.3% is S', meta.bandFor(56.3).tier === 'S');
check('  53.0% is A', meta.bandFor(53.0).tier === 'A');
check('  50.2% is B', meta.bandFor(50.2).tier === 'B');
check('  45.1% is D', meta.bandFor(45.1).tier === 'D');
check('  a missing win rate is not a band', meta.bandFor(undefined) === null);

console.log('\nstale meta is refused, because a patch makes it wrong rather than old:');
check('  a fresh snapshot is usable', meta.metaIsFresh(fresh(HEROES)) === true);
check('  a 90 day old snapshot is not', meta.metaIsFresh(stale(HEROES)) === false);
check('  a snapshot with no timestamp is not', meta.metaIsFresh({ patch: '9.5' }) === false);
const staleAdvice = meta.heroAdvice({ name: 'Peni Parker' }, stale(HEROES), null);
check('  and it produces no tier at all', staleAdvice === null,
  'quoting a pre-patch tier list sounds authoritative and is wrong');

console.log('\none or two games is not a record:');
check('  3 games is not enough', meta.playerForm({ matches: 3, kd: 2.0 }) === null);
check('  4 games is', meta.playerForm({ matches: 4, kd: 2.0 }).level === 'strong');
check('  no record at all', meta.playerForm(null) === null);

console.log('\nTHE CASES THAT MATTER, where the player and the meta disagree:');

// The whole point. The tier list is pulling them toward a hero they cannot use.
const sTierBadAt = meta.heroAdvice({ name: 'Peni Parker' }, fresh(HEROES),
  { matches: 12, kd: 0.7, winRate: 38 });
check('  S-tier hero the player is bad at -> avoid',
  sTierBadAt && sTierBadAt.verdict === 'avoid', JSON.stringify(sTierBadAt));
check('  and it says why, without hiding the tier',
  sTierBadAt && /not a free win/i.test(sTierBadAt.reason), sTierBadAt && sTierBadAt.reason);

// The mirror case: their best hero is out of favour and they should keep it.
const dTierGoodAt = meta.heroAdvice({ name: 'Jubilee' }, fresh(HEROES),
  { matches: 20, kd: 1.6, winRate: 64 });
check('  weak-tier hero the player is good at -> pick',
  dTierGoodAt && dTierGoodAt.verdict === 'pick', JSON.stringify(dTierGoodAt));
check('  and it tells them to keep playing it',
  dTierGoodAt && /keep picking/i.test(dTierGoodAt.reason), dTierGoodAt && dTierGoodAt.reason);

console.log('\nwith no personal record, the meta is what it is for:');
const noRecord = meta.heroAdvice({ name: 'Rocket Raccoon' }, fresh(HEROES), null);
check('  an S-tier hero is recommended', noRecord && noRecord.verdict === 'pick');
check('  and it admits the player has no record',
  noRecord && /not played it enough/i.test(noRecord.reason), noRecord && noRecord.reason);

console.log('\nsilence when there is nothing honest to say:');
check('  unknown hero, no record, no meta',
  meta.heroAdvice({ name: 'Nobody' }, fresh(HEROES), null) === null);
check('  no hero name', meta.heroAdvice({}, fresh(HEROES), null) === null);
check('  no meta and no record', meta.heroAdvice({ name: 'Mantis' }, null, null) === null);

console.log('\nexact win rates are never handed to the player:');
const all = [sTierBadAt, dTierGoodAt, noRecord].filter(Boolean);
check('  no reason string quotes a decimal win rate',
  all.every((a) => !/\d\d\.\d\s*%/.test(a.reason)),
  all.map((a) => a.reason).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
