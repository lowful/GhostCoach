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

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
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

  if (lm.startedAt < startedAt - MATCH_LINK_LEAD_MS) return { ok: false, why: 'match started before the session' };
  if (lm.startedAt > endedAt + MATCH_LINK_TRAIL_MS)  return { ok: false, why: 'match started after the session' };

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
  MATCH_LINK_LEAD_MS, MATCH_LINK_TRAIL_MS,
};
