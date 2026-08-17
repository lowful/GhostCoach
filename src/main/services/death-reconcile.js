'use strict';

/**
 * Checking the deaths the coach read off the screen against the ones Riot
 * recorded.
 *
 * The screen-reading detector is good but not exact. Measured across five real
 * sessions against the tracker it missed 3 deaths in one, 2 in another, and
 * invented 1 in a third. Riot's match detail knows precisely: which round each
 * death happened in, who did it, and with what.
 *
 * The hard part is not comparing the two numbers, it is knowing WHICH deaths the
 * session could possibly have seen. Coaching rarely covers a whole match: one
 * real session ran for nine frames at the start of an eighteen round game, and
 * the player's first death was in round 5. Comparing 0 detected against 11 in
 * the match would call that a catastrophic miss when the detector was perfectly
 * correct. So the comparison is always against the deaths inside the rounds the
 * session actually watched.
 */

// The round the session was watching is derived from the scoreboard, and that
// read lags: three deaths verified against their screenshots all carried a score
// one round behind what the screenshot showed. So the window is widened by this
// much at each end before anything is called missing.
const ROUND_SLACK = 1;

/** The span of rounds a session covered, from the scores it managed to read. */
function roundsCovered(records) {
  let lo = null, hi = null;
  for (const r of (Array.isArray(records) ? records : [])) {
    const s = r.state || {};
    if (typeof s.teamScore !== 'number' || typeof s.enemyScore !== 'number') continue;
    const round = s.teamScore + s.enemyScore + 1;
    if (lo == null || round < lo) lo = round;
    if (hi == null || round > hi) hi = round;
  }
  if (lo == null) return null;
  return { from: Math.max(1, lo - ROUND_SLACK), to: hi + ROUND_SLACK };
}

/**
 * Compare what the coach saw with what Riot recorded.
 *
 * @param detected  deaths from the frames, as ai-log-timeline produces them
 * @param tracker   { total, rounds, deaths: [{ round, killer, weapon, atMs }] }
 * @param records   the session's frames, for working out the rounds covered
 */
function reconcile(detected, tracker, records) {
  const mine = Array.isArray(detected) ? detected : [];
  const theirs = (tracker && Array.isArray(tracker.deaths)) ? tracker.deaths : null;
  if (!theirs) return { status: 'unavailable', detected: mine.length };

  const span = roundsCovered(records);
  // Without a readable scoreboard anywhere there is no way to say which part of
  // the match this was, so the whole match is the window and the verdict says so.
  const inWindow = span
    ? theirs.filter((d) => d.round == null || (d.round >= span.from && d.round <= span.to))
    : theirs;

  const expected = inWindow.length;
  const found = mine.length;
  const status = found === expected ? 'agrees' : (found < expected ? 'missed' : 'overcounted');

  return {
    status,
    detected: found,
    expected,
    matchTotal: theirs.length,
    matchRounds: tracker.rounds || null,
    covered: span,
    partial: !!(span && tracker.rounds && (span.from > 1 || span.to < tracker.rounds)),
    // Paired in order ONLY when the counts agree. Forcing a pairing across a
    // mismatch would attach the wrong killer to the wrong moment, which reads as
    // confident detail and is worse than leaving it off.
    pairs: status === 'agrees'
      ? mine.map((d, i) => ({ at: d.at, round: inWindow[i].round, killer: inWindow[i].killer, weapon: inWindow[i].weapon }))
      : [],
    // The rounds Riot says had a death, so the interface can name them even when
    // the counts disagree and no pairing is possible.
    rounds: inWindow.map((d) => d.round).filter((r) => r != null),
  };
}

/** One line a person can read, for the log header. */
function summarise(rec) {
  if (!rec || rec.status === 'unavailable') return '';
  const scope = rec.partial && rec.covered
    ? ` in rounds ${rec.covered.from} to ${rec.covered.to}`
    : '';
  if (rec.status === 'agrees') {
    return `Riot confirms ${rec.expected} death${rec.expected === 1 ? '' : 's'}${scope}, all found.`;
  }
  if (rec.status === 'missed') {
    const n = rec.expected - rec.detected;
    return `Riot recorded ${rec.expected} death${rec.expected === 1 ? '' : 's'}${scope}, the coach found ${rec.detected}, so ${n} went unseen.`;
  }
  const n = rec.detected - rec.expected;
  return `Riot recorded ${rec.expected} death${rec.expected === 1 ? '' : 's'}${scope}, the coach marked ${rec.detected}, so ${n} is not real.`;
}

/**
 * A cache that remembers answers and forgets failures.
 *
 * Confirmed results never change, so they are kept for the life of the process
 * and reopening the log costs nothing against a strict tracker rate limit.
 * Failures must expire, and that difference is the whole point: the tracker
 * takes a minute or two to index a match after it ends, and the session a player
 * opens first is the one they just played. Remembering "no match lines up"
 * forever meant checking once, seconds too early, then never again, so the
 * confirmation silently never arrived for the game they actually cared about.
 */
function makeCheckCache(ttlMs, now = () => Date.now()) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.rec.status !== 'unavailable') return hit.rec;   // settled
      if (now() - hit.at < ttlMs) return hit.rec;             // too soon to retry
      map.delete(key);
      return null;
    },
    remember(key, rec) { map.set(key, { at: now(), rec }); return rec; },
    get size() { return map.size; },
  };
}

module.exports = { reconcile, summarise, roundsCovered, makeCheckCache, ROUND_SLACK };
