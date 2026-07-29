// Exercise the death-location gate against the real tips from the session the
// player flagged: the ones that named the right spot must still pass, and the
// ones that named a different place must be rejected.
const { isDeathReview, wrongDeathSpot } =
  require('C:\\Users\\alsul\\ghostcoach\\src\\main\\services\\coaching-engine.js').__test;

const deadCtx = (spot) => ({ playerAlive: false, phase: 'dead', deathSpot: spot });

// [tip, pinned death spot, should it be rejected]
const cases = [
  // Correct ones from the log: these must still reach the player.
  ['You died alone in A Sewer while your team was in spawn, wait for them.', 'A Sewer', false],
  ['You pushed A Sewer alone while your team was in spawn, giving Reyna a free kill.', 'A Sewer', false],
  ['You died in Mid Window while your team was stacking C Lobby, stay with your team.', 'Mid Window', false],
  // Wrong ones from the log: drifted to the spectator camera.
  ['You pushed into C Link alone while the spike was down, giving them an easy pick.', 'A Sewer', true],
  ['Still pushing solo into C Link while the spike is down, wait for your team.', 'A Sewer', true],
  ['You walked into Mid Window alone while flashed, giving the defenders a free kill.', 'A Sewer', true],
  // Invented a place when nothing was captured.
  ['You died alone at B Site while your team was in spawn, wait for them to contact.', null, true],
  ['You died dry peeking A Long alone, wait for your team to group.', 'A Lobby', true],
  // No location named at all: always fine.
  ['You died to a crossfire, reset after the kill instead of repeeking.', null, false],
  ['You died taking a dry duel with no trade partner nearby.', 'A Sewer', false],
];

let pass = 0, fail = 0;
for (const [tip, spot, shouldReject] of cases) {
  const isReview = isDeathReview(tip, deadCtx(spot));
  const wrong = isReview ? wrongDeathSpot(tip.toLowerCase(), spot) : null;
  const rejected = !!wrong;
  const ok = rejected === shouldReject;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${rejected ? 'REJECT' : 'allow '}  pinned=${String(spot).padEnd(11)} ${wrong ? `named "${wrong}"` : ''}`);
  if (!ok) console.log(`        tip: ${tip}`);
}

// What matters is whether a tip is ALLOWED THROUGH, not whether the gate looks
// at it. A tip that names no location must always survive, even while dead.
const allowed = (tip, ctx) => !(isDeathReview(tip, ctx) && wrongDeathSpot(tip.toLowerCase(), ctx.deathSpot));

const habit = 'Clear one angle at a time from cover, never wide swing into multiple angles.';
if (allowed(habit, deadCtx('A Sewer'))) { pass++; console.log('PASS  a general habit tip still gets through while dead'); }
else { fail++; console.log('FAIL  a general habit tip was blocked'); }

const mate = 'Trade your teammate the moment they die instead of holding your angle.';
if (allowed(mate, deadCtx('A Sewer'))) { pass++; console.log('PASS  a teammate death tip still gets through'); }
else { fail++; console.log('FAIL  a teammate death tip was blocked'); }

// And a live tip naming somewhere else is untouched once the player respawns.
const live = { playerAlive: true, phase: 'active', lastDeathAt: 0, deathSpot: null };
if (allowed('Hold a tight angle at C Link and wait for your team.', live)) {
  pass++; console.log('PASS  a live tip can name any location after respawn');
} else { fail++; console.log('FAIL  a live tip was blocked'); }

// While alive with no recent death, the gate stays off entirely.
if (!isDeathReview('You died at A Sewer.', { playerAlive: true, phase: 'active', lastDeathAt: 0 })) {
  pass++; console.log('PASS  gate is off when no death is in play');
} else { fail++; console.log('FAIL  gate fired with no death in play'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
