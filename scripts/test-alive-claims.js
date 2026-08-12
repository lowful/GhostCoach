'use strict';

/**
 * A spectated teammate's health is not the player's health.
 *
 * The moment a player dies, Valorant shows the SPECTATED teammate's health in
 * the same bottom-center slot, so "hp 100" is completely routine while dead.
 * The model read this correctly and still reported alive:true, with its own
 * aliveTell saying "Spectating player candy with Ghost bottom left".
 *
 * That single contradiction made every genuine death review look like a
 * hallucination: the coach correctly said "you died", the state said full
 * health, and downstream logic concluded the model was inventing deaths. A
 * client guard was then built on that conclusion and started suppressing
 * correct coaching. Both sessions of "fabricated" deaths turned out to be real
 * deaths, visible in the screenshots as a SWITCH PLAYER prompt and a KILLED BY
 * panel.
 *
 * So the rule is: when the tell says spectating, the tell beats the number, and
 * the number is DROPPED rather than kept, because it belongs to somebody else.
 *
 * Every aliveTell below is verbatim from a logged session.
 *
 * Run: npm run test:alive
 */
const path = require('path');

// The route module builds a Supabase client at import time and throws without
// these. mapState is pure and never touches it, so placeholders are enough to
// let the module load. Set BEFORE the require.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key-not-used';

const { mapState } = require(path.join(__dirname, '..', 'server', 'routes', 'coach.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// Real readings where the model claimed the player was alive at full health
// while simultaneously describing a spectator HUD.
const SPECTATING = [
  ['Spectating player candy with Ghost bottom left', 100],
  ['Spectating Iso with 100 HP and Marshal bottom center', 100],
  ['Spectating Turbo with Jett loadout bottom center', 100],
  ['teammate Iso HP 100 and Vandal bottom center', 100],
  ['switch player prompt bottom left, killcam playing', 75],
];

console.log('a spectator tell beats the health number:');
for (const [tell, hp] of SPECTATING) {
  const out = mapState({ alive: true, hp, aliveTell: tell });
  check(`  "${tell.slice(0, 46)}"`,
    out.playerAlive === false && out.playerHp == null,
    `got alive:${out.playerAlive} hp:${out.playerHp}, both must indicate dead with no health`);
}

console.log('\na genuine own-health reading is untouched:');
const ALIVE = [
  ['own HP 100 and Ghost bottom center', 100],
  ['own HP 75 and Sheriff bottom center', 75],
  ['own rifle and HP 87 bottom center', 87],
  ['own HP 100 and knife bottom center', 100],
];
for (const [tell, hp] of ALIVE) {
  const out = mapState({ alive: true, hp, aliveTell: tell });
  check(`  "${tell.slice(0, 46)}"`,
    out.playerAlive === true && out.playerHp === hp,
    `got alive:${out.playerAlive} hp:${out.playerHp}`);
}

console.log('\nthe original contradiction still resolves the original way:');
// alive:false with a readable OWN health number was the first bug ever fixed
// here, the model announcing deaths that had not happened. Health still wins
// when nothing says spectating.
const contradiction = mapState({ alive: false, hp: 87, aliveTell: 'own HP 87 and Vandal bottom center' });
check('  alive:false with own HP 87 is treated as alive',
  contradiction.playerAlive === true && contradiction.playerHp === 87,
  `got alive:${contradiction.playerAlive} hp:${contradiction.playerHp}`);

// A death with no health number at all: nothing to contradict, stays dead.
const plainDeath = mapState({ alive: false, hp: null, aliveTell: 'no HP number, death recap on screen' });
check('  a plain death with no health number stays dead',
  plainDeath.playerAlive === false && plainDeath.playerHp == null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
