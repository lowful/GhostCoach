'use strict';

/**
 * Which map was actually being played, across a logged session.
 *
 * A session often covers several matches, and the obvious way to find the
 * boundaries is to watch the model's map read change. That is wrong, and the
 * logs say so plainly. Across five real sessions the model reported:
 *
 *     Sunset x119, Bind x3, Lotus x3      (one match, score 1-0 up to 12-5)
 *     Haven  x65,  Lotus x5, Bind x1      (one match, score 0-0 up to 4-4)
 *     Sunset x49,  Haven x6, Bind x1      (one match, score 0-0 up to 5-3)
 *
 * Every one of those sessions was a SINGLE map. Splitting on a map change would
 * have cut them into seven, nine and eight matches. This is the same failure the
 * map lock exists for, arriving here through the log rather than through a tip.
 *
 * So matches are not found from the map read at all. They are found from the
 * SCOREBOARD, because a new match starts at 0-0 and the score otherwise only
 * climbs. Within a match the map is then decided by two independent methods that
 * must agree:
 *
 *   1. the model's own reads, taken as a plurality over the whole match rather
 *      than frame by frame, so three bad frames cannot outvote a hundred good
 *      ones
 *   2. mapFromLabels, the rarity-weighted fingerprint built from the location
 *      names Valorant prints on screen, which is the more reliable of the two
 *      and is what the engine itself trusts over the model
 *
 * When they disagree the labels win, matching the engine, and the segment is
 * reported as unconfirmed so the interface can say so rather than assert it.
 */
const { __test } = require('./coaching-engine');

// A map change with no score reset behind it needs this many consecutive frames
// AND an agreeing label fingerprint before it counts. The longest run of pure
// misreads measured in real logs is 2 (a session opened "Bind, Bind" on Sunset),
// so anything at or under that must never be able to create a segment.
const MIN_RUN = 5;

// The score total dropping by more than this is read as a new match. One point
// of slack absorbs a single misread digit; a real match reset drops by the whole
// scoreline, which in practice is far larger.
const RESET_DROP = 2;

const scoreTotal = (s) =>
  (s && typeof s.teamScore === 'number' && typeof s.enemyScore === 'number')
    ? s.teamScore + s.enemyScore : null;

/**
 * Frame indices where a new match begins, from the scoreboard alone.
 *
 * A drop needs TWO agreeing frames before it is believed, which is the rule the
 * engine's scoreboard continuity already uses: a single frame reading 0-0
 * mid-match is a misread, and treating it as a match boundary would split a game
 * in half every time the scoreboard was briefly unreadable.
 */
function matchStarts(records) {
  const starts = [0];
  let last = null;
  for (let i = 0; i < records.length; i++) {
    const t = scoreTotal(records[i].state);
    if (t == null) continue;                       // unreadable never splits
    if (last != null && t <= last - RESET_DROP) {
      const next = records.slice(i + 1).find((r) => scoreTotal(r.state) != null);
      const agrees = next && scoreTotal(next.state) >= t && scoreTotal(next.state) <= last - RESET_DROP;
      if (agrees) { starts.push(i); last = t; continue; }
      continue;                                    // lone low read, not a reset
    }
    last = t;
  }
  return starts;
}

/** The map for one span of frames, decided twice and cross-checked. */
function mapOf(records, from, to) {
  const span = records.slice(from, to + 1);

  const votes = new Map();
  for (const r of span) {
    const m = r.state && r.state.map;
    if (m) votes.set(m, (votes.get(m) || 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  // A tie is not a plurality. Insertion order would otherwise pick a winner, and
  // "whichever map the model happened to name first" is not evidence.
  const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  const byModel = (ranked.length && !tied) ? ranked[0][0] : null;

  const labels = span.map((r) => r.state && r.state.locLabel).filter(Boolean);
  const fp = __test.mapFromLabels(labels) || {};
  const byLabel = fp.confident ? fp.map : null;

  // The labels are the better witness, so they decide when the two disagree.
  // Agreement is what "confirmed" means here, and it is reported rather than
  // assumed, because an interface that states the wrong map confidently is worse
  // than one that admits it is unsure.
  const map = byLabel || byModel;
  return {
    map,
    confirmed: !!(byLabel && byModel && byLabel === byModel),
    byModel,
    byLabel,
    votes: ranked.map(([m, n]) => ({ map: m, frames: n })),
    labels: new Set(labels).size,
  };
}

/**
 * Segments of a session, one per match, each with the map it was played on.
 *
 * Consecutive segments on the same map are merged, because a score reset within
 * one map is a new match but not a map change, and the timeline marks map
 * changes.
 */
function segments(records) {
  const recs = Array.isArray(records) ? records : [];
  if (!recs.length) return [];

  const starts = matchStarts(recs);
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = (i + 1 < starts.length ? starts[i + 1] - 1 : recs.length - 1);
    const seg = { from, to, ...mapOf(recs, from, to) };

    // A map change with no scoreboard behind it. Believed only when the read
    // holds for a real run AND the labels in that run agree, so the two
    // witnesses are still both required.
    const prev = out[out.length - 1];
    if (prev && prev.map && seg.map && prev.map === seg.map) { prev.to = seg.to; continue; }
    out.push(seg);
  }

  return splitOnSustainedChange(recs, out);
}

/**
 * Catch a genuine map change the scoreboard missed, without letting a flicker
 * through. Requires a run of at least MIN_RUN frames naming the new map AND the
 * labels within that run agreeing, which is the same two-witness rule used
 * everywhere else here.
 */
function splitOnSustainedChange(recs, segs) {
  const out = [];
  for (const seg of segs) {
    // The first frame where a map other than the segment's own holds for
    // MIN_RUN frames. Unreadable frames inside the run are tolerated, since the
    // scoreboard and the map both blank out during a killcam, but a frame naming
    // a DIFFERENT map breaks it.
    let cut = -1;
    for (let i = seg.from; i <= seg.to - MIN_RUN + 1; i++) {
      const m = recs[i].state && recs[i].state.map;
      if (!m || m === seg.map) continue;
      let holds = true;
      for (let k = i; k < i + MIN_RUN; k++) {
        const mk = recs[k].state && recs[k].state.map;
        if (mk && mk !== m) { holds = false; break; }
      }
      // The second witness: the printed location names over the rest of the
      // segment must fingerprint the same new map.
      if (holds && mapOf(recs, i, seg.to).byLabel === m) { cut = i; break; }
    }
    if (cut > seg.from) {
      out.push({ ...mapOf(recs, seg.from, cut - 1), from: seg.from, to: cut - 1 });
      out.push({ ...mapOf(recs, cut, seg.to), from: cut, to: seg.to });
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** Just the maps a session was played on, in order, for a compact label. */
function mapsPlayed(records) {
  return segments(records).map((s) => s.map).filter(Boolean)
    .filter((m, i, a) => m !== a[i - 1]);
}

module.exports = { segments, mapsPlayed, matchStarts, MIN_RUN };
