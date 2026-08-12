'use strict';

/**
 * The coach must not tell a living player they are dead.
 *
 * Every REAL case below is verbatim from one session, with the health number
 * the HUD was showing at that moment. Ten tips in that session narrated a death
 * that had not happened and several reached the overlay, including one at 100 HP
 * and one at 85 HP mid fight, plus "You are spectating Iso" to a player who was
 * alive and playing.
 *
 * The existing death guards all assumed a death had really happened and only
 * argued about WHERE it was, so an invented death had nothing watching it. This
 * is HP beats death applied to the tip text: a readable health number above zero
 * means alive, and no sentence gets to contradict it.
 *
 * Run: npm run test:alive
 */
const path = require('path');
const { __test } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));
const { claimsNotAlive, verifyTip } = __test;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// Verbatim from the session, with the HP the HUD showed.
const SHOWN_WHILE_ALIVE = [
  [100, 'You died holding that tight angle alone because your team is dead top side.'],
  [85,  'You died holding A Short alone with a pistol because you were caught out.'],
  [100, 'You are spectating Iso holding A Tower, so stop dry peeking that choke.'],
  [100, 'You died holding A Bath alone against a Sage, so next round hold tighter.'],
  [30,  'You died holding B Short wide without a trade partner, so reset next time.'],
];

// The map is set on every context below so the callout gate is satisfied and
// the guard under test is the one that actually decides.
console.log('a tip claiming death must not survive a living player:');
for (const [hp, tip] of SHOWN_WHILE_ALIVE) {
  const ctx = { playerAlive: true, playerHp: hp, phase: 'active', agentConfirmed: false, map: 'Bind' };
  const out = verifyTip(tip, 'ai', ctx);
  check(`  at ${hp} HP: ${tip.slice(0, 46)}...`, out === false || out === null,
    `verifyTip let it through: ${JSON.stringify(out)}`);
}

// A real review names where the player actually died, which the engine pinned at
// the time, so deathSpot is set exactly as it would be in a live session.
console.log('\na REAL death review must still get through:');
const realDeath = [
  [{ playerAlive: false, phase: 'dead', playerHp: null, deathSpot: 'A Main' },
    'You died holding A Main alone without a flash or a trade partner.'],
  [{ playerAlive: true, playerHp: 100, phase: 'active', lastDeathAt: Date.now() - 3000, deathSpot: 'A Tower' },
    'You died dry peeking A Tower alone, flash the angle first next time.'],
];
for (const [ctx, tip] of realDeath) {
  const label = ctx.phase === 'dead' ? 'while dead' : 'just respawned, inside the death window';
  const out = verifyTip(tip, 'ai', { agentConfirmed: false, map: 'Bind', ...ctx });
  check(`  ${label}`, out !== false && out !== null, 'a genuine death review was suppressed');
}

console.log('\nno health read means no verdict, so nothing is suppressed on a guess:');
const unknown = verifyTip('You died holding B Site alone without a trade.', 'ai',
  { playerHp: null, playerAlive: null, phase: null, agentConfirmed: false });
check('  unknown state lets the tip stand', unknown !== false && unknown !== null);

console.log('\nthe detector is narrow, ordinary advice is untouched:');
const INNOCENT = [
  'Trade your teammate when they die instead of pushing past the body.',
  'Hold A Site tight and let them walk into your crosshair.',
  'They died to a wide swing, so hold that angle tighter.',
  'Watch your teammate on the minimap before you rotate.',
];
for (const tip of INNOCENT) {
  check(`  "${tip.slice(0, 44)}..."`, claimsNotAlive(tip) === null,
    `wrongly flagged as claiming death: ${claimsNotAlive(tip)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
