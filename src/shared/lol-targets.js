'use strict';

/**
 * What "good" is for each metric, and how much of that we can actually defend.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: grade against the player's own recent
 * baseline first. Riot publishes no per-rank or per-role benchmarks for any of
 * these stats. Third-party tables exist, they disagree with each other, and
 * several widely repeated figures have no primary source at all. So the rank
 * band is a stretch layer on top of a personal baseline, never the judgement
 * itself.
 *
 * Every metric therefore carries `sourced`, and the UI reads it:
 *
 *   sourced: true    there is defensible outside data. Show a band target, and
 *                    still say it is directional.
 *   sourced: false   there is not. Grade against the player's own last ten
 *                    games and SAY SO on screen.
 *
 * A metric with `sourced: false` has NO band table, and test:lolgrader asserts
 * that, so a number cannot quietly be added later. That is deliberate: a wrong
 * target is worse than no target, because the player will chase it. It is
 * ABSENCE MEANS SILENCE from rivals-heroes.js, pointed at numbers instead of
 * heroes.
 *
 * FIVE BANDS, NOT EIGHT RANKS. The underlying data does not support eight-way
 * granularity, and pretending otherwise means inventing seven numbers to sit
 * between the two that are real.
 */

const BANDS = [
  { n: 1, name: 'Iron and Bronze' },
  { n: 2, name: 'Silver' },
  { n: 3, name: 'Gold' },
  { n: 4, name: 'Platinum and Emerald' },
  { n: 5, name: 'Diamond and above' },
];

const DEFAULT_BAND = 2;

/**
 * How many games of history make a baseline worth grading against.
 *
 * Below this the surface says it is still learning the player rather than
 * showing a delta computed from two games, which would swing wildly and read as
 * authority.
 */
const MIN_BASELINE_GAMES = 3;
const BASELINE_GAMES = 10;

const TARGETS = {
  /**
   * The one metric with reasonably consistent third-party data, and even here
   * the honest word is directional. Junglers sit roughly a full CS per minute
   * below these, and supports do not see this skill at all: chasing CS as a
   * support takes it from the ADC, which loses the game more reliably than a
   * low number on this line ever would.
   */
  csAt10: {
    sourced: true,
    note: 'Directional, from community data rather than anything Riot publishes.',
    bands: { 1: 50, 2: 55, 3: 65, 4: 75, 5: 85 },
    roleOffset: { Jungle: -10 },     // about a CS per minute under a solo lane
    excludeRoles: ['Support'],
  },

  /**
   * No sourced per-rank data exists for this. These are judgement values and
   * the UI must present them as a personal stretch, never as a rank standard.
   */
  deathsBy15: {
    sourced: false,
    note: 'A stretch, not a standard. No published per-rank figure exists for this.',
    stretch: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1 },
  },

  /**
   * NO BAND TABLE AT ALL, on purpose. Riot has published nothing, and the
   * commonly repeated "above 35 is good" traces back to no primary source. The
   * role floors below are a sanity check on shape and are labelled as such on
   * screen; they never become the target.
   */
  visionPerMin: {
    sourced: false,
    note: 'Graded against your own last ten games. No trustworthy rank benchmark exists for vision.',
    roleFloor: { Support: 1.5, Jungle: 1.5, Top: 1, Mid: 1, Bot: 1 },
  },

  turretsHelped:      { sourced: false, note: 'Graded against your own last ten games.' },
  deathsAhead:        { sourced: false, note: 'Graded against your own last ten games.' },
  goldHeld:           { sourced: false, note: 'Graded against your own last ten games.' },
  objectiveSetup:     { sourced: false, note: 'Graded against your own last ten games.' },
  deathsInLostFights: { sourced: false, note: 'Graded against your own last ten games.' },
};

function band(n) {
  const i = Number(n);
  return BANDS.find((b) => b.n === i) || BANDS.find((b) => b.n === DEFAULT_BAND);
}

function targetFor(metricId) { return TARGETS[String(metricId || '')] || null; }

/** Whether a metric applies to a role at all. */
function appliesTo(metricId, role) {
  const t = targetFor(metricId);
  if (!t) return false;
  return !(t.excludeRoles || []).includes(String(role || ''));
}

/**
 * The band number for a metric and role, or null when there is no defensible
 * one. Null is the common case and is not a failure: it routes the caller to
 * the personal baseline, which is where most of these belong anyway.
 */
function bandTarget(metricId, bandN, role) {
  const t = targetFor(metricId);
  if (!t || !t.sourced || !t.bands) return null;
  if (!appliesTo(metricId, role)) return null;
  const base = t.bands[band(bandN).n];
  if (typeof base !== 'number') return null;
  const off = (t.roleOffset || {})[String(role || '')] || 0;
  return base + off;
}

/**
 * The stretch value for a metric with no sourced benchmark, or null.
 *
 * Kept separate from bandTarget on purpose. They are not the same kind of thing
 * and a caller that cannot tell them apart will present a judgement call as a
 * measurement.
 */
function stretchTarget(metricId, bandN) {
  const t = targetFor(metricId);
  if (!t || t.sourced || !t.stretch) return null;
  const v = t.stretch[band(bandN).n];
  return typeof v === 'number' ? v : null;
}

module.exports = {
  BANDS, DEFAULT_BAND, TARGETS, BASELINE_GAMES, MIN_BASELINE_GAMES,
  band, targetFor, appliesTo, bandTarget, stretchTarget,
};
