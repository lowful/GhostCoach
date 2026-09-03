'use strict';

/**
 * The twelve League skills, as assignments rather than reading.
 *
 * A lesson is not something you read. It is an assignment with a number on it,
 * checked automatically after the next game, and the player does not advance
 * until it sticks. This file says what each skill IS and how it is graded; the
 * prose lives in lol-curriculum.js and is referenced by id rather than copied,
 * because two files holding the same sentences is how they drift apart.
 *
 * THREE GRADING CLASSES, and the third one is not a gap.
 *
 *   hard    a number read straight off the Live Client Data API
 *   proxy   derived from event timing, honest but indirect
 *   replay  not gradeable at all, anchored to a replay timestamp instead
 *
 * The replay class exists because of what the API genuinely does not expose. It
 * gives scores and timestamped events; it gives NO position, camera, minion or
 * wave state. So "the wave has a direction" and "look at the map on a timer"
 * cannot be measured, and the correct response is to say so rather than to
 * invent a number that looks like measurement. A metric nobody can defend is
 * worse than no metric, because the player will chase it.
 *
 * That is ABSENCE MEANS SILENCE from rivals-heroes.js, applied to numbers.
 */

const METRICS = {
  // ── hard: read directly off the API ──────────────────────────────────────
  csAt10:        { id: 'csAt10',        label: 'CS at 10:00',                 better: 'higher' },
  deathsBy15:    { id: 'deathsBy15',    label: 'Deaths before 15:00',         better: 'lower'  },
  visionPerMin:  { id: 'visionPerMin',  label: 'Vision score per minute',     better: 'higher' },
  turretsHelped: { id: 'turretsHelped', label: 'Turret takedowns joined',     better: 'higher' },
  deathsAhead:   { id: 'deathsAhead',   label: 'Deaths while holding a lead', better: 'lower'  },

  // ── proxy: derived from event timing ─────────────────────────────────────
  goldHeld:      { id: 'goldHeld',      label: 'Time holding 1400+ unspent',  better: 'lower'  },
  objectiveSetup:{ id: 'objectiveSetup',label: 'Alive into objective spawns', better: 'higher' },
  deathsInLostFights: {
    id: 'deathsInLostFights',
    label: 'Deaths joining a fight already lost',
    better: 'lower',
  },
};

/**
 * Skills in curriculum order.
 *
 * `lesson` points at lol-curriculum.js for the title, the mistake, the body and
 * the practice question. Nothing here restates them.
 *
 * The exception is skill 11. Every other skill keeps its existing copy word for
 * word; that one was rewritten because the original, "In a teamfight, your job
 * depends on your range", is about where you stand, and the API publishes no
 * position data at all, so it could never be graded. The replacement measures
 * the two ways games are actually lost at these ranks and both fall out of
 * timestamps alone.
 */
const SKILLS = [
  // ── Fundamentals ─────────────────────────────────────────────────────────
  { n: 1,  id: 'f-csing',    lesson: 'f-csing',    category: 'fundamentals', klass: 'hard',   metric: 'csAt10',
    // Chasing CS as a support actively hurts the ADC, so this skill is not
    // shown to them at all rather than shown with a softer target.
    notForRoles: ['Support'] },
  { n: 2,  id: 'f-death',    lesson: 'f-death',    category: 'fundamentals', klass: 'hard',   metric: 'deathsBy15' },
  { n: 3,  id: 'f-vision',   lesson: 'f-vision',   category: 'fundamentals', klass: 'hard',   metric: 'visionPerMin' },
  { n: 4,  id: 'f-map',      lesson: 'f-map',      category: 'fundamentals', klass: 'replay',
    // Recorded during the game, seeked to afterwards. Nothing about where a
    // player was looking is in the API.
    replayTrigger: 'death with no ally death within 20s' },

  // ── Laning ───────────────────────────────────────────────────────────────
  { n: 5,  id: 'l-wave',     lesson: 'l-wave',     category: 'laning', klass: 'replay',
    replayTrigger: 'death within 30s of a recall' },
  { n: 6,  id: 'l-trade',    lesson: 'l-trade',    category: 'laning', klass: 'replay',
    replayTrigger: 'death in lane before 10:00 with no enemy jungler credit' },
  { n: 7,  id: 'l-recall',   lesson: 'l-recall',   category: 'laning', klass: 'proxy',  metric: 'goldHeld' },
  { n: 8,  id: 'l-roam',     lesson: 'l-roam',     category: 'laning', klass: 'replay',
    replayTrigger: 'death in another lane before 10:00' },

  // ── The Map ──────────────────────────────────────────────────────────────
  { n: 9,  id: 'm-objectives', lesson: 'm-objectives', category: 'macro', klass: 'proxy', metric: 'objectiveSetup' },
  { n: 10, id: 'm-tempo',      lesson: 'm-tempo',      category: 'macro', klass: 'hard',  metric: 'turretsHelped' },
  { n: 11, id: 'm-numbers',    lesson: 'm-numbers',    category: 'macro', klass: 'proxy', metric: 'deathsInLostFights' },
  { n: 12, id: 'm-close',      lesson: 'm-close',      category: 'macro', klass: 'hard',  metric: 'deathsAhead' },
];

const CLASSES = ['hard', 'proxy', 'replay'];

function skills() { return SKILLS; }

/** One skill by id, or null. Unknown means silence, as everywhere else. */
function skill(id) {
  return SKILLS.find((s) => s.id === String(id || '')) || null;
}

/** The skill a metric belongs to, or null. */
function skillForMetric(metricId) {
  return SKILLS.find((s) => s.metric === String(metricId || '')) || null;
}

/**
 * The skills a player in this role should be shown.
 *
 * Role is optional: with no role known, everything is shown, because hiding a
 * skill on a guess is worse than showing one that does not apply.
 */
function forRole(role) {
  const r = String(role || '').trim();
  if (!r) return SKILLS;
  return SKILLS.filter((s) => !(s.notForRoles || []).includes(r));
}

function metric(id) { return METRICS[String(id || '')] || null; }

module.exports = { SKILLS, METRICS, CLASSES, skills, skill, skillForMetric, forRole, metric };
