'use strict';

/**
 * The weekly report: which stats moved, how the four categories rate, what the
 * player is doing well, and what to work on.
 *
 * Pure assembly, no I/O and no electron. The caller gathers the inputs (tracker
 * profile, the baseline snapshot, the coached-session log) and this decides what
 * is worth saying. Kept separate from the main process so the logic that decides
 * what a player is told about their week can be tested directly.
 */

// Rank ladder for trend arrows: "Gold 2" -> a comparable number. Unknown -> null.
const RANK_LADDER = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'ascendant', 'immortal', 'radiant'];

function rankIndex(r) {
  const l = String(r || '').toLowerCase();
  const i = RANK_LADDER.findIndex((t) => l.startsWith(t));
  if (i < 0) return null;
  const div = parseInt(l.replace(/[^\d]/g, ''), 10);
  return i * 3 + (isNaN(div) ? 2 : div);
}

/** 'up' | 'down' | 'flat', with a deadband so noise is not reported as change. */
function trendDirection(cur, prev, deadband = 2) {
  if (cur == null || prev == null) return 'flat';
  const d = cur - prev;
  return d > deadband ? 'up' : d < -deadband ? 'down' : 'flat';
}

/** ISO-style week key ("2026-W30") so the report shows once per calendar week. */
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));       // nearest Thursday
  const week = Math.ceil(((t - new Date(Date.UTC(t.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const CATEGORY_LABEL = { impact: 'Impact', positioning: 'Positioning', utility: 'Utility', aim: 'Aim' };

// Which stats the report tracks. deadband keeps normal week-to-week noise from
// being announced as progress or decline.
const WEEKLY_STATS = [
  { key: 'rank',        label: 'Rank',         fmt: (v) => String(v),           deadband: 0 },
  { key: 'winRate',     label: 'Win rate',     fmt: (v) => Math.round(v) + '%', deadband: 2 },
  { key: 'kd',          label: 'K/D',          fmt: (v) => (+v).toFixed(2),     deadband: 0.05 },
  { key: 'headshotPct', label: 'Headshot %',   fmt: (v) => Math.round(v) + '%', deadband: 1 },
  { key: 'acs',         label: 'Combat score', fmt: (v) => Math.round(v),       deadband: 6 },
  { key: 'adr',         label: 'Damage/round', fmt: (v) => Math.round(v),       deadband: 5 },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build the report.
 *
 * input = {
 *   riotId, stats (current tracker profile | null), base (week-ago snapshot | null),
 *   snapshotAt, perf (coached sessions, oldest first), categories (from
 *   computeCategoryTrends), now
 * }
 *
 * Returns { hasData:false, reason } when there is not enough history to say
 * anything honest, because a report of blanks and invented praise is worse than
 * not opening at all.
 */
function assembleReport(input) {
  const { riotId = '', stats = null, base = null, snapshotAt = null, categories = {} } = input || {};
  const now  = input && input.now ? input.now : Date.now();
  const perf = Array.isArray(input && input.perf) ? input.perf : [];
  const week = perf.filter((r) => r && typeof r.at === 'number' && r.at >= now - WEEK_MS);

  if (!stats && !week.length) {
    return { hasData: false, reason: riotId ? 'no-activity' : 'not-connected', riotId };
  }

  // Stat movement against the baseline captured at the start of the week.
  const deltas = [];
  if (stats) {
    for (const d of WEEKLY_STATS) {
      const cur = stats[d.key];
      if (cur == null || cur === '') continue;
      const prev = base ? base[d.key] : null;
      const row  = { label: d.label, value: d.fmt(cur), direction: 'flat', change: null };
      if (d.key === 'rank') {
        row.direction = prev ? trendDirection(rankIndex(cur), rankIndex(prev), 0) : 'flat';
        if (prev && prev !== cur) row.change = String(prev) + ' to ' + String(cur);
      } else if (typeof prev === 'number' && typeof cur === 'number') {
        const diff = cur - prev;
        if (Math.abs(diff) >= d.deadband) {
          row.direction = diff > 0 ? 'up' : 'down';
          const shown = d.key === 'kd' ? Math.abs(diff).toFixed(2) : Math.round(Math.abs(diff));
          row.change = (diff > 0 ? '+' : '-') + shown;
        }
      }
      deltas.push(row);
    }
  }

  // Strongest and weakest of the four rated categories.
  const rated = Object.entries(categories || {})
    .filter(([, v]) => v && v.avg != null)
    .sort((a, b) => b[1].avg - a[1].avg);
  const best  = rated.length     ? { key: rated[0][0], label: CATEGORY_LABEL[rated[0][0]], ...rated[0][1] } : null;
  const worst = rated.length > 1 ? { key: rated[rated.length - 1][0], label: CATEGORY_LABEL[rated[rated.length - 1][0]], ...rated[rated.length - 1][1] } : null;

  // The coach's own written notes from this week's graded sessions.
  const clean = (t) => String(t || '').trim().replace(/\s+/g, ' ');
  const uniq  = (arr) => [...new Set(arr.map(clean).filter((s) => s.length > 8))].slice(0, 3);
  const doingWell = uniq(week.map((r) => r.strengths));
  const toImprove = uniq(week.map((r) => r.weaknesses));

  const avgOverall = week.length
    ? Math.round(week.reduce((s, r) => s + (r.overall || 0), 0) / week.length) : null;

  return {
    hasData: true,
    weekOf: weekKey(new Date(now)),
    since: base ? snapshotAt : null,
    riotId,
    rank: stats ? stats.rank : null,
    matchesTracked: stats ? stats.matches : null,
    sessions: week.length,
    avgOverall,
    deltas,
    categories,
    best,
    worst,
    doingWell,
    toImprove,
    // With no baseline we say so, rather than showing flat arrows that read as
    // "no progress" when they really mean "nothing to compare against".
    firstWeek: !base,
  };
}

module.exports = { assembleReport, weekKey, rankIndex, trendDirection, WEEK_MS, CATEGORY_LABEL };
