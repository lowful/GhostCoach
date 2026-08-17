'use strict';

/**
 * Checking screen-read deaths against Riot's record.
 *
 * The trap this exists for is comparing the wrong two numbers. Coaching rarely
 * covers a whole match, and one real session ran for nine frames at the start of
 * an eighteen round game in which the player's first death was in round 5.
 * Comparing its 0 detected deaths against the match's 11 would report a
 * catastrophic miss when the detector was exactly right. So the comparison is
 * always against the deaths inside the rounds the session actually watched.
 *
 * Run: npm run test:deathreconcile
 */
const path = require('path');
const { reconcile, summarise, roundsCovered } =
  require(path.join(__dirname, '..', 'src', 'main', 'services', 'death-reconcile.js'));

let fails = 0;
const ok = (cond, what) => { if (!cond) { fails++; console.log(`FAIL  ${what}`); } else console.log(`ok    ${what}`); };

/** Frames carrying a scoreline, which is how the covered rounds are worked out. */
const frames = (rounds) => rounds.map((r) => ({
  state: { teamScore: Math.ceil((r - 1) / 2), enemyScore: Math.floor((r - 1) / 2) },
}));
const death = (round) => ({ round, killer: `enemy${round}#eu`, weapon: 'Vandal', atMs: 20000 });
const found = (n) => Array.from({ length: n }, (_, i) => ({ at: i * 5 }));

// ── The partial-session trap, taken from a real session ─────────────────────
{
  // Nine frames covering round 1 of an eighteen round match whose first death
  // was in round 5. The detector found nothing and was right.
  const tracker = { rounds: 18, total: 11, deaths: [5, 6, 7, 8, 9, 11, 13, 14, 15, 16, 18].map(death) };
  const r = reconcile([], tracker, frames([1, 1, 1]));
  ok(r.status === 'agrees', `a session that ended before the first death AGREES (got ${r.status})`);
  ok(r.expected === 0, `nothing was expected in the rounds it watched (expected ${r.expected})`);
  ok(r.matchTotal === 11, 'the full match total is still reported');
  ok(r.partial === true, 'and it is flagged as covering only part of the match');
  ok(/0 deaths in rounds 1 to 2/.test(summarise(r)), `the summary says which rounds (${summarise(r)})`);
}

// ── The three real verdicts ─────────────────────────────────────────────────
{
  const tracker = { rounds: 9, total: 7, deaths: [1, 2, 3, 4, 5, 6, 7].map(death) };
  const whole = frames([1, 5, 9]);
  ok(reconcile(found(7), tracker, whole).status === 'agrees', 'equal counts agree');
  ok(reconcile(found(5), tracker, whole).status === 'missed', 'fewer found is a miss');
  ok(reconcile(found(8), tracker, whole).status === 'overcounted', 'more found is an overcount');
  const m = reconcile(found(5), tracker, whole);
  ok(/2 went unseen/.test(summarise(m)), `the miss is counted in words (${summarise(m)})`);
  const o = reconcile(found(8), tracker, whole);
  ok(/1 is not real/.test(summarise(o)), `so is the overcount (${summarise(o)})`);
}

// ── Pairing ─────────────────────────────────────────────────────────────────
{
  const tracker = { rounds: 9, total: 3, deaths: [2, 5, 8].map(death) };
  const agree = reconcile(found(3), tracker, frames([1, 9]));
  ok(agree.pairs.length === 3, 'agreeing counts are paired in order');
  ok(agree.pairs[1].round === 5 && agree.pairs[1].killer === 'enemy5#eu',
    'each mark gets the real round and killer');

  // A forced pairing across a mismatch attaches the wrong killer to the wrong
  // moment, which reads as confident detail while being wrong.
  const off = reconcile(found(2), tracker, frames([1, 9]));
  ok(off.pairs.length === 0, 'a mismatch pairs NOTHING rather than guessing');
  ok(off.rounds.join() === '2,5,8', 'but the rounds Riot recorded are still reported');
}

// ── The scoreboard lags, so the window has slack ────────────────────────────
{
  // Three deaths verified against screenshots all carried a score one round
  // behind the screenshot, so a death on the edge must not be called missing.
  const tracker = { rounds: 9, total: 1, deaths: [death(6)] };
  const r = reconcile(found(1), tracker, frames([1, 5]));   // read only up to round 5
  ok(r.status === 'agrees', 'a death one round past the last readable score still counts');
}

// ── Degenerate input ────────────────────────────────────────────────────────
ok(reconcile(found(3), null, frames([1])).status === 'unavailable', 'no tracker data is unavailable, not a miss');
ok(reconcile(found(3), {}, frames([1])).status === 'unavailable', 'an empty tracker reply is unavailable too');
ok(summarise({ status: 'unavailable' }) === '', 'and it says nothing rather than something wrong');
ok(roundsCovered([]) === null, 'a session with no readable score has no round span');
{
  // No readable scoreboard anywhere: the whole match is the window, and the
  // verdict must not pretend to know which part was watched.
  const tracker = { rounds: 9, total: 2, deaths: [death(3), death(7)] };
  const r = reconcile(found(2), tracker, [{ state: {} }, { state: {} }]);
  ok(r.status === 'agrees' && r.covered === null, 'an unreadable scoreboard compares against the whole match');
}

console.log(fails ? `\n${fails} failure(s)` : '\nall death reconcile checks passed');
process.exit(fails ? 1 : 0);
