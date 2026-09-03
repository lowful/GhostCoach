'use strict';

/**
 * The League grader, the target tables and the twelve skills.
 *
 * EVERY EVENT RULE GETS A KNOWN POSITIVE AND A KNOWN NEGATIVE, the same
 * discipline as the tip glyph lexicon, where the negatives are what caught both
 * real bugs. A grader is worse than useless if it is confidently wrong: the
 * player is being told what to practise next, and a false failure sends them to
 * work on something that was never the problem.
 *
 * The assertions that matter most are the ones about ABSENCE. A metric with no
 * defensible benchmark must have no band table, a missing field must come back
 * "unmeasured" rather than zero, and too little history must come back
 * "learning" rather than a delta computed from two games.
 */
const lessons = require('../src/shared/lol-lessons');
const targets = require('../src/shared/lol-targets');
const grader = require('../src/shared/lol-grader');
const curriculum = require('../src/shared/lol-curriculum');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); return; }
  console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  failures++;
}

const kill = (t, victim, killer) => ({ EventName: 'ChampionKill', EventTime: t, VictimName: victim, KillerName: killer || 'Enemy' });
const ME = 'Me';
const ALLIES = ['A1', 'A2', 'A3', 'A4'];

// ── The twelve skills ───────────────────────────────────────────────────────
console.log('[lol] skills');
{
  check('there are twelve', lessons.SKILLS.length === 12, String(lessons.SKILLS.length));

  const counts = {};
  for (const s of lessons.SKILLS) counts[s.klass] = (counts[s.klass] || 0) + 1;
  check('classes are hard 5, proxy 3, replay 4',
    counts.hard === 5 && counts.proxy === 3 && counts.replay === 4, JSON.stringify(counts));

  const ids = lessons.SKILLS.map((s) => s.id);
  check('skill ids are unique', new Set(ids).size === ids.length);

  // The prose lives in exactly one place. A skill pointing at a lesson that
  // does not exist renders an empty card.
  const orphan = lessons.SKILLS.filter((s) => !curriculum.lesson(s.lesson));
  check('every skill resolves to a lesson', orphan.length === 0, orphan.map((s) => s.lesson).join(', '));

  // A graded skill needs a metric and a replay skill must not have one.
  const badGraded = lessons.SKILLS.filter((s) => s.klass !== 'replay' && !s.metric);
  const badReplay = lessons.SKILLS.filter((s) => s.klass === 'replay' && s.metric);
  check('every graded skill has a metric', badGraded.length === 0, badGraded.map((s) => s.id).join(', '));
  check('no replay skill has a metric', badReplay.length === 0, badReplay.map((s) => s.id).join(', '));
  const noTrigger = lessons.SKILLS.filter((s) => s.klass === 'replay' && !s.replayTrigger);
  check('every replay skill has a trigger', noTrigger.length === 0, noTrigger.map((s) => s.id).join(', '));

  // Chasing CS as a support takes it from the ADC.
  check('support does not see the CS skill',
    !lessons.forRole('Support').some((s) => s.metric === 'csAt10'));
  check('mid does see it', lessons.forRole('Mid').some((s) => s.metric === 'csAt10'));
  check('an unknown role sees everything', lessons.forRole('Nonsense').length === 12);
  check('skill() on nonsense is null', lessons.skill('nope') === null);
}

// ── Targets, and what must NOT be there ─────────────────────────────────────
console.log('\n[lol] targets');
{
  check('CS mid band 3 is 65', targets.bandTarget('csAt10', 3, 'Mid') === 65);
  check('CS jungle sits a CS a minute lower', targets.bandTarget('csAt10', 3, 'Jungle') === 55);
  check('CS band 5 is 85', targets.bandTarget('csAt10', 5, 'Mid') === 85);
  check('CS is excluded for support', targets.bandTarget('csAt10', 3, 'Support') === null);

  // THE ONE THAT KEEPS THIS HONEST. An unsourced metric must never grow a band
  // table, because a number on screen gets chased whether or not it is real.
  const invented = Object.entries(targets.TARGETS).filter(([, t]) => !t.sourced && t.bands);
  check('no unsourced metric has a band table', invented.length === 0,
    invented.map(([k]) => k).join(', '));

  check('vision has no band target at all', targets.bandTarget('visionPerMin', 3, 'Mid') === null);
  check('deaths has no band target either', targets.bandTarget('deathsBy15', 3, 'Mid') === null);
  check('deaths DOES have a stretch', targets.stretchTarget('deathsBy15', 3) === 2);
  check('a sourced metric has no stretch', targets.stretchTarget('csAt10', 3) === null);

  const noEntry = Object.values(lessons.METRICS).filter((m) => !targets.targetFor(m.id));
  check('every metric has a target entry', noEntry.length === 0, noEntry.map((m) => m.id).join(', '));
  const noNote = Object.entries(targets.TARGETS).filter(([, t]) => !t.note);
  check('every target explains itself', noNote.length === 0, noNote.map(([k]) => k).join(', '));
  check('an unknown band falls back rather than throwing', targets.band(99).n === targets.DEFAULT_BAND);
}

// ── Metric 11, the important one ────────────────────────────────────────────
console.log('\n[lol] deaths: joined a lost fight, or caught alone');
{
  // POSITIVE: ally dies at 100, I die at 119. Nineteen seconds, inside 20.
  let r = grader.analyseDeaths([kill(100, 'A1'), kill(119, ME)], ME, ALLIES);
  check('ally death 19s before counts as joining a lost fight', r.joinedLost === 1, JSON.stringify(r));

  // NEGATIVE: same shape, 21 seconds. Outside the window, so it is not one.
  r = grader.analyseDeaths([kill(100, 'A1'), kill(121, ME)], ME, ALLIES);
  check('ally death 21s before does NOT', r.joinedLost === 0, JSON.stringify(r));

  // Boundary, stated explicitly so a later refactor cannot move it by accident.
  r = grader.analyseDeaths([kill(100, 'A1'), kill(120, ME)], ME, ALLIES);
  check('exactly 20s is inside the window', r.joinedLost === 1);

  // An ally dying AFTER me is not evidence I joined a lost fight: I may have
  // started it. But it does mean I was not alone.
  r = grader.analyseDeaths([kill(100, ME), kill(110, 'A1')], ME, ALLIES);
  check('an ally dying after me is not joining a lost fight', r.joinedLost === 0);
  check('and it does not count as caught alone either', r.caughtAlone === 0, JSON.stringify(r));

  // POSITIVE for the other pattern: nobody died anywhere near me.
  r = grader.analyseDeaths([kill(300, ME)], ME, ALLIES);
  check('a death with no ally death near it is caught alone', r.caughtAlone === 1);
  check('caught alone records a replay mark for skill 4',
    r.marks.length === 1 && r.marks[0].skill === 'f-map', JSON.stringify(r.marks));

  // An ENEMY dying next to me is not an ally dying next to me.
  r = grader.analyseDeaths([kill(100, 'Enemy1'), kill(110, ME)], ME, ALLIES);
  check('an enemy death nearby does not count as an ally', r.caughtAlone === 1, JSON.stringify(r));

  // My own kills are not my deaths.
  r = grader.analyseDeaths([kill(100, 'Enemy1', ME), kill(101, 'Enemy2', ME)], ME, ALLIES);
  check('kills I got are not deaths', r.deaths === 0);

  check('an empty event list is quiet',
    grader.analyseDeaths([], ME, ALLIES).deaths === 0);
  check('junk events do not throw',
    grader.analyseDeaths([{}, { EventName: 'ChampionKill' }, null], ME, ALLIES).deaths === 0);
}

// ── The other event rules ───────────────────────────────────────────────────
console.log('\n[lol] turrets and objectives');
{
  const ev = [
    { EventName: 'TurretKilled', EventTime: 500, KillerName: ME },
    { EventName: 'TurretKilled', EventTime: 900, KillerName: 'A1', Assisters: [ME] },
    { EventName: 'TurretKilled', EventTime: 1200, KillerName: 'A2', Assisters: ['A3'] },
  ];
  check('turret takedowns count kills and assists', grader.turretsHelped(ev, ME) === 2, String(grader.turretsHelped(ev, ME)));
  check('a turret I had no part in does not count', grader.turretsHelped(ev, 'A4') === 0);
  check('no turret events is zero, not a throw', grader.turretsHelped([], ME) === 0);

  const objEv = [{ EventName: 'DragonKill', EventTime: 600 }, { EventName: 'BaronKill', EventTime: 1500 }];
  check('alive into both objectives', grader.objectiveSetup(objEv, ME, []).ready === 2);
  // Died 30s before the dragon, so I was not there to set it up.
  check('a death inside the 90s window costs one',
    grader.objectiveSetup(objEv, ME, [570]).ready === 1, JSON.stringify(grader.objectiveSetup(objEv, ME, [570])));
  // Died 100s before: back up in time, so it does not count against me.
  check('a death outside the window does not',
    grader.objectiveSetup(objEv, ME, [500]).ready === 2);
  // NOT MEASURED, not zero. A game with no objectives is not a failure.
  check('no objectives at all returns null rather than zero',
    grader.objectiveSetup([], ME, []) === null);
}

// ── Baselines and verdicts ──────────────────────────────────────────────────
console.log('\n[lol] baseline and verdicts');
{
  const hist = (vals) => vals.map((v) => ({ measured: { csAt10: v } }));

  check('too little history is no baseline', grader.baseline('csAt10', hist([50, 60])) === null);
  check('three games is enough', grader.baseline('csAt10', hist([50, 60, 70])) === 60);
  check('only the last ten count',
    grader.baseline('csAt10', hist([0, 0, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60])) === 60);
  check('an empty history is null', grader.baseline('csAt10', []) === null);
  check('missing metrics in history are skipped',
    grader.baseline('csAt10', [{ measured: {} }, ...hist([60, 60, 60])]) === 60);

  const skill = lessons.skill('f-csing');
  // Higher is better for CS.
  check('beating the baseline passes',
    grader.judge(skill, 70, 3, 'Mid', hist([60, 60, 60])).verdict === 'pass');
  check('missing it fails',
    grader.judge(skill, 50, 3, 'Mid', hist([60, 60, 60])).verdict === 'fail');
  check('with no baseline the verdict is learning, never fail',
    grader.judge(skill, 10, 3, 'Mid', hist([60])).verdict === 'learning');

  // Lower is better for deaths, so the comparison has to invert.
  const deathSkill = lessons.skill('f-death');
  const dHist = [{ measured: { deathsBy15: 4 } }, { measured: { deathsBy15: 4 } }, { measured: { deathsBy15: 4 } }];
  check('fewer deaths than baseline passes',
    grader.judge(deathSkill, 2, 3, 'Mid', dHist).verdict === 'pass');
  check('more deaths than baseline fails',
    grader.judge(deathSkill, 6, 3, 'Mid', dHist).verdict === 'fail');

  check('a sourced metric carries its band target',
    grader.judge(skill, 70, 3, 'Mid', hist([60, 60, 60])).target === 65);
  check('an unsourced metric carries none',
    grader.judge(deathSkill, 2, 3, 'Mid', dHist).target === null);
}

// ── A whole game ────────────────────────────────────────────────────────────
console.log('\n[lol] a graded game');
{
  const game = {
    me: ME, allies: ALLIES, role: 'Mid', band: 3,
    stats: { csAt10: 55, deathsBy15: 4, wardScore: 20, gameTimeSec: 1800, deathsAhead: 1, goldHeldSec: 90 },
    events: [kill(100, 'A1'), kill(115, ME), kill(600, ME), { EventName: 'DragonKill', EventTime: 900 }],
  };
  const hist = [1, 2, 3].map(() => ({ measured: { csAt10: 70, deathsBy15: 2, visionPerMin: 1, turretsHelped: 1, deathsAhead: 0, goldHeld: 30, objectiveSetup: 1, deathsInLostFights: 0 } }));
  const out = grader.gradeGame(game, hist);

  check('it grades the graded skills only',
    out.results.length === lessons.SKILLS.filter((s) => s.klass !== 'replay').length,
    String(out.results.length));
  check('no replay skill appears in results',
    !out.results.some((r) => (lessons.skill(r.skill) || {}).klass === 'replay'));
  check('metric 11 came through', out.fights.joinedLost === 1, JSON.stringify(out.fights));
  check('the lone death is caught alone', out.fights.caughtAlone === 1);

  // A field the API did not give must be unmeasured, never a zero that fails.
  const thin = grader.gradeGame({ me: ME, allies: ALLIES, role: 'Mid', band: 3, stats: {}, events: [] }, hist);
  const csRes = thin.results.find((r) => r.metric === 'csAt10');
  check('a missing field is unmeasured, not a failure', csRes && csRes.verdict === 'unmeasured',
    JSON.stringify(csRes));

  // A support is never assigned the CS skill.
  const sup = grader.gradeGame(Object.assign({}, game, { role: 'Support' }), hist);
  check('a support game never grades CS', !sup.results.some((r) => r.metric === 'csAt10'));

  // The coach chooses, and it chooses the worst RELATIVE miss.
  const pick = grader.recommend(out.results);
  check('it recommends a real skill', lessons.skill(pick) !== null, String(pick));
  check('it recommends something that failed',
    (out.results.find((r) => r.skill === pick) || {}).verdict === 'fail', String(pick));

  const clean = grader.gradeGame(game, []);
  check('with no history it still recommends something', grader.recommend(clean.results) !== null);
  check('recommend on nothing is null rather than a throw', grader.recommend([]) === null);
}

if (failures) {
  console.log('\nFAIL: ' + failures + ' grader check(s) failed');
  process.exit(1);
}
console.log('\nPASS: it grades against the player, invents no benchmark, and says unmeasured when it does not know');
