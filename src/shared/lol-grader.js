'use strict';

/**
 * Grade a finished League game against the twelve skills.
 *
 * IN src/shared/ AND NOT IN server/, for the same reason lol-champions.js is:
 * only server/ deploys to Railway and check:server enforces that it never
 * reaches outside itself. Nothing on the backend grades a match. This runs in
 * the main process on data the client already has, which is also why it works
 * with no network.
 *
 * WHAT IT REFUSES TO DO. Every number here is compared against the player's own
 * recent baseline first, and a band target is only ever a stretch on top of
 * that. See lol-targets.js: most of these metrics have no defensible outside
 * benchmark, and inventing one would be worse than having none, because a
 * player will chase whatever number you put on the screen.
 *
 * THE SCHEMA IS NOT VERIFIED. The Live Client Data API on 127.0.0.1:2999 was
 * not reachable while this was written (no client running), so the exact field
 * names for this patch are unconfirmed. Everything is read through num() and
 * arr(), which tolerate absence. A missing field must produce "not measured",
 * never a zero that grades as a failure. Check the real schema at
 * /swagger/v3/openapi.json on a running client before trusting any of this.
 */

const lessons = require('./lol-lessons');
const targets = require('./lol-targets');

/** Seconds either side of an ally death that count as the same fight. */
const FIGHT_WINDOW_S = 20;

// Defensive readers. A field that is absent is UNKNOWN, not zero. Grading a
// missing number as a failure is the specific way this kind of code lies.
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');
/**
 * Event entries, with anything that is not an object dropped.
 *
 * arr() guards the LIST and num()/str() guard the FIELDS, and between those two
 * sat a gap: a null entry in the array reached a property read and threw. The
 * schema is unverified against this patch, so a malformed entry is exactly the
 * thing to expect, and a grader that throws on one bad event loses the whole
 * game's grading rather than one line of it.
 */
const evts = (v) => arr(v).filter((e) => e && typeof e === 'object');

/**
 * METRIC 11, and the reason it was built first.
 *
 * ChampionKill events carry a timestamp, a victim and a killer, and that alone
 * separates the two ways games are actually lost at these ranks:
 *
 *   joinedLost   died within 20s AFTER an ally died. Walked into a fight that
 *                was already down a body.
 *   caughtAlone  died with no ally death anywhere near it. Nobody was fighting.
 *
 * Neither needs a model, a position, or anything but timestamps. Everything
 * else in this file is easier than this one and less useful.
 */
function analyseDeaths(events, me, allies) {
  const mine = new Set(arr(allies).map(str).filter(Boolean));
  const self = str(me);
  const kills = evts(events)
    .filter((e) => str(e.EventName) === 'ChampionKill')
    .map((e) => ({ t: num(e.EventTime), victim: str(e.VictimName), killer: str(e.KillerName) }))
    .filter((e) => e.t !== null && e.victim)
    .sort((a, b) => a.t - b.t);

  const myDeaths = kills.filter((k) => k.victim === self);
  const allyDeaths = kills.filter((k) => k.victim !== self && mine.has(k.victim));

  let joinedLost = 0;
  let caughtAlone = 0;
  const marks = [];

  for (const d of myDeaths) {
    // An ally who died BEFORE me, inside the window: the fight was already
    // going badly when I arrived. An ally dying after me is not evidence of
    // anything, since I may have been the one who started it.
    const priorAlly = allyDeaths.some((a) => a.t <= d.t && d.t - a.t <= FIGHT_WINDOW_S);
    const nearAlly = priorAlly || allyDeaths.some((a) => a.t > d.t && a.t - d.t <= FIGHT_WINDOW_S);

    if (priorAlly) joinedLost += 1;
    if (!nearAlly) {
      caughtAlone += 1;
      // Skill 4 anchors here: no ally died near this, so nobody was fighting
      // and the minimap would have shown it.
      marks.push({ skill: 'f-map', at: d.t, why: 'No ally died near this, so nobody was fighting.' });
    }
  }

  return { deaths: myDeaths.length, joinedLost, caughtAlone, marks };
}

/** Turret takedowns the player was credited on. */
function turretsHelped(events, me) {
  const self = str(me);
  return evts(events).filter((e) => {
    if (str(e.EventName) !== 'TurretKilled') return false;
    if (str(e.KillerName) === self) return true;
    return arr(e.Assisters).map(str).includes(self);
  }).length;
}

/**
 * Alive into the objective spawns, as a proxy for having set them up.
 *
 * Being dead when a dragon or baron lands is the clearest evidence available
 * that the ninety seconds before it went somewhere else. It is a proxy and the
 * class on the skill says so.
 */
function objectiveSetup(events, me, deathTimes) {
  const spawns = evts(events).filter((e) => {
    const n = str(e.EventName);
    return n === 'DragonKill' || n === 'BaronKill' || n === 'HeraldKill';
  }).map((e) => num(e.EventTime)).filter((t) => t !== null);

  if (!spawns.length) return null;   // nothing happened, so nothing to grade

  let ready = 0;
  for (const t of spawns) {
    const diedInto = arr(deathTimes).some((d) => d <= t && t - d <= 90);
    if (!diedInto) ready += 1;
  }
  return { of: spawns.length, ready };
}

/**
 * Mean of the last games for one metric, or null when there is not enough.
 *
 * Null is not a failure. It routes the caller to "still learning you", which is
 * an honest thing to show and a delta computed from two games is not.
 */
function baseline(metricId, history) {
  const vals = arr(history)
    .slice(-targets.BASELINE_GAMES)
    .map((h) => num(((h && h.measured) || {})[metricId]))
    .filter((v) => v !== null);
  if (vals.length < targets.MIN_BASELINE_GAMES) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

/**
 * Pass or fail one skill.
 *
 * Order matters and is the point of the whole file: the personal baseline is
 * the judgement, and a sourced band target is only ever consulted as a stretch
 * on top of it.
 */
function judge(skill, value, bandN, role, history) {
  const m = lessons.metric(skill.metric);
  const lowerIsBetter = !!(m && m.better === 'lower');
  const base = baseline(skill.metric, history);

  const out = {
    skill: skill.id,
    metric: skill.metric,
    measured: value,
    baseline: base,
    target: targets.bandTarget(skill.metric, bandN, role),
    stretch: targets.stretchTarget(skill.metric, bandN),
    sourced: !!(targets.targetFor(skill.metric) || {}).sourced,
  };

  if (base === null) { out.verdict = 'learning'; return out; }

  out.delta = Math.round((value - base) * 100) / 100;
  out.verdict = (lowerIsBetter ? value <= base : value >= base) ? 'pass' : 'fail';
  return out;
}

/**
 * Grade one finished game.
 *
 * @param {object} game   { me, allies, role, band, stats, events }
 * @param {object[]} history previous per-game records, newest last
 */
function gradeGame(game, history) {
  const g = game || {};
  const stats = g.stats || {};
  const events = arr(g.events);
  const role = str(g.role);
  const bandN = num(g.band) || targets.DEFAULT_BAND;

  const deathTimes = evts(events)
    .filter((e) => str(e.EventName) === 'ChampionKill' && str(e.VictimName) === str(g.me))
    .map((e) => num(e.EventTime)).filter((t) => t !== null);

  const fights = analyseDeaths(events, g.me, g.allies);
  const minutes = (num(stats.gameTimeSec) || 0) / 60;
  const obj = objectiveSetup(events, g.me, deathTimes);

  const measured = {
    csAt10:             num(stats.csAt10),
    deathsBy15:         num(stats.deathsBy15),
    visionPerMin:       minutes > 0 && num(stats.wardScore) !== null
      ? Math.round((stats.wardScore / minutes) * 100) / 100 : null,
    turretsHelped:      turretsHelped(events, g.me),
    deathsAhead:        num(stats.deathsAhead),
    goldHeld:           num(stats.goldHeldSec),
    objectiveSetup:     obj ? obj.ready : null,
    deathsInLostFights: fights.joinedLost,
  };

  const results = [];
  for (const skill of lessons.forRole(role)) {
    if (skill.klass === 'replay' || !skill.metric) continue;
    const value = measured[skill.metric];
    if (value === null || value === undefined) {
      // NOT MEASURED is a real outcome and says so. It is never a fail.
      results.push({ skill: skill.id, metric: skill.metric, measured: null, verdict: 'unmeasured' });
      continue;
    }
    results.push(judge(skill, value, bandN, role, history));
  }

  return {
    results,
    fights: { deaths: fights.deaths, joinedLost: fights.joinedLost, caughtAlone: fights.caughtAlone },
    marks: fights.marks,
    measured,
  };
}

/**
 * Which skill to assign next: the one the player is worst at relative to their
 * own baseline.
 *
 * The coach chooses, and that is not UI taste. Given twelve free choices players
 * pick the interesting ones and skip warding, which is the one that would have
 * moved them two divisions.
 */
function recommend(results) {
  const graded = arr(results).filter((r) => r.verdict === 'fail' && typeof r.delta === 'number');
  if (!graded.length) {
    const learning = arr(results).find((r) => r.verdict === 'learning');
    return learning ? learning.skill : ((arr(results)[0] || {}).skill || null);
  }
  // Worst RELATIVE miss, so a metric counted in deaths cannot outrank one
  // counted in CS purely because its numbers are bigger.
  const score = (r) => {
    const m = lessons.metric(r.metric);
    const dir = (m && m.better === 'lower') ? 1 : -1;
    const denom = Math.abs(r.baseline) || 1;
    return (r.delta * dir) / denom;
  };
  return graded.slice().sort((a, b) => score(b) - score(a))[0].skill;
}

module.exports = {
  FIGHT_WINDOW_S, gradeGame, analyseDeaths, turretsHelped, objectiveSetup,
  baseline, judge, recommend,
};
