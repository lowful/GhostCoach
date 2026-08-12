'use strict';

/**
 * Scoreboard tracking: the round number is derived, not read.
 *
 * Valorant's HUD prints two scores at the top and does not print a round
 * number, so any round the model reports is one it inferred, and it infers
 * badly. Across a real session it sat on round 3 while the score climbed 2-1,
 * 2-2, 3-2.
 *
 * That was expensive rather than cosmetic. The continuity guard treats a round
 * that disagrees with the scores as an implausible reading and discards the
 * WHOLE thing, both scores included, so good scoreboard reads were being thrown
 * out because of a number the model made up. The tracked score went as long as
 * 249 seconds without an update, about two and a half rounds blind.
 *
 * Valorant's arithmetic settles it: round = your score + their score + 1.
 *
 * The readings below are verbatim from that session.
 *
 * Run: npm run test:scoreboard
 */
const path = require('path');
const CoachingEngine = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

/**
 * A real engine driven through its REAL merge, without starting capture,
 * sockets or timers.
 *
 * The first version of this test re-implemented the derivation and then asserted
 * its own arithmetic, which would have passed with the engine completely
 * unchanged. It now calls updateMatchContext, so the thing under test is the
 * shipped code.
 */
function freshEngine(prev) {
  const e = Object.create(CoachingEngine.prototype);
  e.matchContext = { roundNumber: 0, teamScore: 0, enemyScore: 0, ...(prev || {}) };
  e.scoreboardChallenge = null;
  e.lastScoreAt = 0;              // first read of a session has no ceiling to beat
  e.seenLabels = [];
  e.lastDeathAt = 0;
  e.deathTipsSent = 0;
  e.enemyHistory = [];
  e.matchMemory = [];
  e.tipHistory = [];
  return e;
}

/** Push a reading through the engine and report the context it settled on. */
function applyScore(engine, updates) {
  engine.updateMatchContext({ ...updates });
  return engine.matchContext;
}

console.log('the round is derived from the printed scores:');
const CASES = [
  [{ teamScore: 2, enemyScore: 1, roundNumber: 3 }, 4, 'score 2-1 reported as round 3'],
  [{ teamScore: 2, enemyScore: 2, roundNumber: 3 }, 5, 'score 2-2 reported as round 3'],
  [{ teamScore: 3, enemyScore: 2, roundNumber: 3 }, 6, 'score 3-2 reported as round 3'],
  [{ teamScore: 0, enemyScore: 0, roundNumber: 1 }, 1, 'pistol round already agrees'],
  [{ teamScore: 1, enemyScore: 0, roundNumber: 2 }, 2, 'score 1-0 already agrees'],
  [{ teamScore: 12, enemyScore: 12, roundNumber: 3 }, 25, 'overtime derives correctly'],
];
for (const [updates, want, name] of CASES) {
  const out = applyScore(freshEngine(), updates);
  check(`  ${name} -> round ${want}`, out.roundNumber === want, `got ${out.roundNumber}`);
}

console.log('\nwith no scores there is nothing to derive from:');
const noScores = applyScore(freshEngine(), { roundNumber: 7 });
check('  the model\'s round stands', noScores.roundNumber === 7, `got ${noScores.roundNumber}`);

console.log('\nthe derived round is self consistent by construction:');
// The invariant check downstream rejects readings where round != team+enemy+1.
// After derivation that can no longer happen, which is the entire point: a good
// score read is never discarded again over an invented round number.
const seq = [
  { teamScore: 0, enemyScore: 0, roundNumber: 1 },
  { teamScore: 1, enemyScore: 0, roundNumber: 2 },
  { teamScore: 1, enemyScore: 1, roundNumber: 3 },
  { teamScore: 2, enemyScore: 1, roundNumber: 3 },
  { teamScore: 2, enemyScore: 2, roundNumber: 3 },
  { teamScore: 3, enemyScore: 2, roundNumber: 3 },
];
let consistent = 0;
for (const s of seq) {
  const out = applyScore(freshEngine(), s);
  if (out.teamScore + out.enemyScore + 1 === out.roundNumber) consistent++;
}
check(`  all ${seq.length} real readings now add up`, consistent === seq.length,
  `${consistent}/${seq.length} consistent`);

// Before the fix, only the readings the model happened to get right survived.
const wouldHaveSurvived = seq.filter((s) => s.teamScore + s.enemyScore + 1 === s.roundNumber).length;
console.log(`\n  (before this change only ${wouldHaveSurvived} of ${seq.length} of these readings`);
console.log(`   were accepted, the other ${seq.length - wouldHaveSurvived} were discarded with their scores)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
