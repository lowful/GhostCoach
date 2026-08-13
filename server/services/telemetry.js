'use strict';

/**
 * Aggregate coaching health, with no player content in it.
 *
 * The AI decision log is the tool that has found nearly every real bug in this
 * app, and it exists only on the player's own machine. That is the right
 * default: a frame is a photograph of somebody's screen, complete with their
 * Discord, their tabs and their stream chat, so collecting frames centrally
 * would turn a low-risk local tool into a genuine liability.
 *
 * The useful part of a log is not the picture though, it is the COUNTS: how many
 * tips were shown, how many were rejected and for which reason. Reject-reason
 * histograms are what exposed the repetition problem, the ability-vocabulary
 * mismatch and the truncation false positive, and none of that needs a single
 * pixel or word of what the player saw.
 *
 * WHAT IS ACCEPTED HERE IS A CLOSED SET. Reject reasons are matched against the
 * known list below and anything unrecognised is counted as "other" rather than
 * stored, so a future reason that happens to interpolate a callout, a player
 * name or a tip cannot leak through by accident. No tip text, no frames, no
 * map, no agent, no identifiers beyond a truncated license hash.
 */

// Every reason the client can currently record, reduced to a stable slug. A
// reason that does not match is counted, never kept.
const REJECT_KINDS = [
  ['similar',        /too similar to a recent tip/i],
  ['repeat-play',    /already recommended|repeated the same ability/i],
  ['verify-gate',    /failed the final verify gate/i],
  ['truncated',      /cut off mid sentence/i],
  ['wrong-map',      /does not belong to the|callout/i],
  ['death-spot',     /death spot/i],
  ['round-decided',  /round is already decided/i],
  ['wrong-side-hold', /while .* confirmed on/i],
  ['spectating',     /spectat/i],
  ['ability',        /ability|abilities/i],
];

function kindOf(reason) {
  const r = String(reason || '');
  for (const [kind, re] of REJECT_KINDS) if (re.test(r)) return kind;
  return 'other';
}

// Rolling in-memory window. Deliberately not persisted: this is for spotting a
// regression across a release, not for building a profile of anyone.
const MAX_SESSIONS = 500;
const sessions = [];

/**
 * Record one finished session.
 * @param report { tipsShown, tipsGenerated, durationMin, rejects: {reason: count} }
 * @param keyHash short, non-reversible tag so repeat sessions can be told apart
 */
function record(report, keyHash) {
  if (!report || typeof report !== 'object') return;
  const rejects = {};
  for (const [reason, n] of Object.entries(report.rejects || {})) {
    const k = kindOf(reason);
    rejects[k] = (rejects[k] || 0) + (Number(n) || 0);
  }
  sessions.push({
    at: Date.now(),
    user: String(keyHash || '').slice(0, 8),
    version: String(report.version || '').slice(0, 12),
    tipsShown: Math.max(0, Math.min(999, Number(report.tipsShown) || 0)),
    tipsGenerated: Math.max(0, Math.min(999, Number(report.tipsGenerated) || 0)),
    durationMin: Math.max(0, Math.min(600, Math.round(Number(report.durationMin) || 0))),
    rejects,
  });
  if (sessions.length > MAX_SESSIONS) sessions.shift();
}

/** Aggregate view for the admin route. Counts only. */
function summary() {
  if (!sessions.length) return { sessions: 0 };
  const byVersion = {};
  const rejectTotals = {};
  let shown = 0, generated = 0, minutes = 0;
  const users = new Set();

  for (const s of sessions) {
    shown += s.tipsShown;
    generated += s.tipsGenerated;
    minutes += s.durationMin;
    if (s.user) users.add(s.user);
    byVersion[s.version || 'unknown'] = (byVersion[s.version || 'unknown'] || 0) + 1;
    for (const [k, n] of Object.entries(s.rejects)) rejectTotals[k] = (rejectTotals[k] || 0) + n;
  }

  const totalRejects = Object.values(rejectTotals).reduce((a, b) => a + b, 0);
  // Sorted so the dominant failure mode is the first thing visible, which is how
  // every bug so far has actually been noticed.
  const rejectRanked = Object.entries(rejectTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => ({ kind, n, pct: totalRejects ? Math.round((n / totalRejects) * 100) : 0 }));

  return {
    sessions: sessions.length,
    distinctUsers: users.size,
    coachedMinutes: minutes,
    tipsShown: shown,
    tipsGenerated: generated,
    // The number worth watching: how much of what the coach writes survives.
    showRate: generated ? Math.round((shown / generated) * 100) : 0,
    tipsPerHour: minutes ? Math.round((shown / minutes) * 60) : 0,
    byVersion,
    rejects: rejectRanked,
  };
}

module.exports = { record, summary, kindOf, REJECT_KINDS };
