'use strict';

/**
 * Deciding whether a tracker match is the one a coaching session watched.
 *
 * Pulled out of index.js so it can be tested directly. This is a guard in the
 * same family as the ones in coaching-engine.js: a session graded against
 * someone else's scoreboard looks authoritative while being completely wrong,
 * which is worse than a session with no scoreboard at all. When in doubt, it
 * refuses to link.
 */

// The match may have started before coaching did (coaching usually begins in
// agent select or a round or two in), or shortly after we started watching.
const MATCH_LINK_LEAD_MS  = 20 * 60 * 1000;
const MATCH_LINK_TRAIL_MS = 10 * 60 * 1000;

// Roughly how long a round takes including the buy phase. Only used to work out
// whether a match was still being played when coaching started, so it wants to
// be about right rather than exact.
const ROUND_MS = 100 * 1000;

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/** Total rounds played, read off the "5-2" scoreline the tracker already sends. */
function roundsPlayed(lm) {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String((lm && lm.score) || ''));
  return m ? (Number(m[1]) + Number(m[2])) : 0;
}

/**
 * When the match finished, estimated from its length.
 *
 * The tracker reports when a match STARTED and never when it ended, which made
 * the start time the only thing available to compare against, and that is the
 * wrong question. A 45 minute competitive match that began 25 minutes before the
 * player hit Start was still very much in progress, and it was refused for
 * "starting before the session" while being the only match they played.
 * Returns null when the scoreline is unreadable, so the caller can fall back.
 */
function matchEndEstimate(lm) {
  if (!lm || !lm.startedAt) return null;
  if (lm.endedAt) return lm.endedAt;          // if a future payload provides it, prefer it
  const rounds = roundsPlayed(lm);
  return rounds ? lm.startedAt + rounds * ROUND_MS : null;
}

/**
 * @param lm         the tracker's last match ({ startedAt, map, agent, ... })
 * @param startedAt  when coaching started
 * @param endedAt    when coaching stopped
 * @param mctx       { map, agent } as the coach actually read them
 * @returns { ok: true } | { ok: false, why: string }
 *
 * Map and agent are only checked when WE know them, because an unknown on our
 * side is not evidence against the match. But anything we do know must agree,
 * and at least one identifying field must be checked: timing alone is far too
 * weak, since back-to-back games overlap the window trivially.
 */
function verifyCoachedMatch(lm, startedAt, endedAt, mctx) {
  if (!lm || !lm.startedAt) return { ok: false, why: 'no match start time' };

  if (lm.startedAt > endedAt + MATCH_LINK_TRAIL_MS)  return { ok: false, why: 'match started after the session' };

  // OVERLAP, NOT START TIME. What makes a match the coached one is that it was
  // being played while the coach was watching. Testing the start time instead
  // threw away a real match for "starting before the session" when the player
  // simply began coaching partway through a long game, which is the normal way
  // this app gets used. Falls back to the old lead window only when the
  // scoreline cannot be read, since then there is nothing to estimate from.
  const end = matchEndEstimate(lm);
  if (end != null) {
    if (end < startedAt) return { ok: false, why: 'match had already finished before coaching started' };
  } else if (lm.startedAt < startedAt - MATCH_LINK_LEAD_MS) {
    return { ok: false, why: 'match started before the session and its length is unknown' };
  }

  const ourMap   = mctx && mctx.map;
  const ourAgent = mctx && mctx.agent;
  if (ourMap && lm.map && !sameName(ourMap, lm.map)) {
    return { ok: false, why: `map mismatch (coached ${ourMap}, match ${lm.map})` };
  }
  if (ourAgent && lm.agent && !sameName(ourAgent, lm.agent)) {
    return { ok: false, why: `agent mismatch (coached ${ourAgent}, match ${lm.agent})` };
  }
  if (!(ourMap && lm.map) && !(ourAgent && lm.agent)) {
    return { ok: false, why: 'no map or agent to confirm the match with' };
  }
  return { ok: true };
}

/** The scoreboard fields worth keeping on a session record. */
function matchSummary(m) {
  if (!m) return null;
  return {
    result: m.result, score: m.score,
    kills: m.kills, deaths: m.deaths, assists: m.assists,
    kd: m.kd, acs: m.acs, adr: m.adr,
    headshotPct: m.headshotPct, grade: m.grade,
    map: m.map, agent: m.agent, startedAt: m.startedAt,
  };
}

module.exports = {
  verifyCoachedMatch, matchSummary, sameName,
  matchEndEstimate, roundsPlayed,
  MATCH_LINK_LEAD_MS, MATCH_LINK_TRAIL_MS, ROUND_MS,
};
