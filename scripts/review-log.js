'use strict';

/**
 * Grade a real coaching session against every failure this app has actually
 * shipped.
 *
 * Every session so far has been reviewed by hand, which is slow, inconsistent,
 * and biased towards whatever I happened to look at. Worse, a fix verified once
 * was never re-checked, so a regression could sit in a log for days. This turns
 * the review into something repeatable: run it after a session and it reports
 * the same numbers in the same order every time.
 *
 * Each check below exists because the failure REALLY HAPPENED, and the comment
 * says which one, so a future reader can tell a real rule from a guess.
 *
 *   npm run review:log            newest session
 *   npm run review:log -- <dir>   a specific session folder
 *
 * Exit code is non-zero when something is over its threshold, so this can gate
 * a release if that is ever wanted.
 */
const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
const LOGS = path.join(APPDATA, 'GhostCoach 2.0', 'ai-log');

const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
let dir = arg;
if (!dir) {
  const sessions = fs.existsSync(LOGS)
    ? fs.readdirSync(LOGS).filter((d) => d.startsWith('session-')).sort().reverse() : [];
  dir = sessions.map((d) => path.join(LOGS, d))
    .find((d) => fs.existsSync(path.join(d, 'log.json'))
      && JSON.parse(fs.readFileSync(path.join(d, 'log.json'), 'utf8')).records.length > 5);
}
if (!dir || !fs.existsSync(path.join(dir, 'log.json'))) {
  console.log('No usable session log found.');
  process.exit(0);
}

const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
const recs = log.records || [];
const shown = recs.filter((r) => r.shown).map((r) => r.shown.text);
const generated = recs.filter((r) => r.aiTip && r.aiTip !== 'SKIP');
const rejects = recs.filter((r) => r.reject);
const minutes = recs.length > 1 ? (recs[recs.length - 1].at - recs[0].at) / 60000 : 0;

let problems = 0;
const results = [];
/** @param severity 'fail' when it is over the line, 'warn' when it is close */
function check(name, ok, detail, severity = 'fail') {
  if (!ok && severity === 'fail') problems++;
  results.push({ name, ok, detail, severity });
}

console.log(`${path.basename(dir)}`);
console.log(`${recs.length} frames, ${minutes.toFixed(1)} min, ${generated.length} tips written, ${shown.length} shown\n`);

// ── Things that must NEVER reach a player ───────────────────────────────────
// Each of these shipped at least once, so they are failures, not warnings.

// "SET UP A CROSSFIRE AT B MAIN WITH YOUR SATELLITE..." was shown mid match.
const shouty = shown.filter((t) => {
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length > 12 && (letters.replace(/[^A-Z]/g, '').length / letters.length) > 0.7;
});
check('no tip SHOUTS in capitals', shouty.length === 0, shouty[0]);

// "...WITH your, AND HOLD AN OFF-ANGLE..." shipped: the noun after the
// possessive was dropped, so the sentence still ended properly and the
// end-of-sentence truncation check could not see it.
const fragment = shown.filter((t) => /\b(your|their|his|her|my|our|the|a|an)\s*[,.]/i.test(t));
check('no dangling possessive mid sentence', fragment.length === 0, fragment[0]);

// "You are lone in B Lobby" reached a player twice across sessions.
const lone = shown.filter((t) => /\b(you are|is) lone\b/i.test(t));
check('no "is/are lone" typo', lone.length === 0, lone[0]);

// A living player told they are dead RIGHT NOW.
//
// Two traps here, both of which have already produced wrong conclusions. The
// spectator HUD shows the SPECTATED teammate's health, so a health number is
// not proof of life and the alive tell decides. And reviewing the previous
// round's death during the next buy phase is perfectly good coaching, so past
// tense while alive is fine; only a PRESENT-tense claim contradicts the screen.
const lastDeathBefore = (at) => {
  let t = 0;
  for (const r of recs) {
    if (r.at > at) break;
    const s = r.state || {};
    if (s.phase === 'dead' || s.playerAlive === false
        || /spectat|switch player|killcam/i.test(String(s.aliveTell || ''))) t = r.at;
  }
  return t;
};
const PRESENT_DEAD = /\byou are (dead|spectating)\b|\byou'?re (dead|spectating)\b/i;
const deadClaim = recs.filter((r) => {
  const s = r.state || {}; const t = (r.shown && r.shown.text) || '';
  if (!t) return false;
  const spectating = /spectat|switch player|killcam/i.test(String(s.aliveTell || ''));
  const alive = !spectating && (s.playerAlive === true || (typeof s.playerHp === 'number' && s.playerHp > 0));
  if (!alive) return false;
  if (PRESENT_DEAD.test(t)) return true;                       // contradicts the screen outright
  // Past tense is a review, and only wrong if no death actually happened.
  return /\byou died\b/i.test(t) && (r.at - lastDeathBefore(r.at)) > 120000;
});
check('never tells a living player they are dead', deadClaim.length === 0,
  deadClaim[0] && (deadClaim[0].shown.text));

// The coach recommending a play and then blaming the player for it.
const PLAYS = [['crossfire', /cross ?fire/i], ['off-angle', /off.?angle/i],
  ['hold-tight', /\b(stay|hold)\s+(tight|low|back)\b|\btight (to|against)\b/i]];
const playOf = (t) => (PLAYS.find(([, re]) => re.test(t)) || [null])[0];
let contradictions = 0;
for (let i = 1; i < shown.length; i++) {
  if (!/\byou died\b/i.test(shown[i])) continue;
  const p = playOf(shown[i]);
  if (p && !/\byou died\b/i.test(shown[i - 1]) && playOf(shown[i - 1]) === p) contradictions++;
}
check('never blames the player for its own advice', contradictions === 0, `${contradictions} case(s)`);

// A callout from a different map, the failure the map lock exists to prevent.
const wrongMap = rejects.filter((r) => /does not belong to/.test(r.reject)).length;
check('no callouts from the wrong map reach the gate', wrongMap === 0, `${wrongMap} rejected`, 'warn');

// ── Quality signals, judged against what past sessions actually did ─────────

const repeatRejects = rejects.filter((r) => /already recommended|too similar|same topic/.test(r.reject)).length;
const repeatShare = rejects.length ? repeatRejects / rejects.length : 0;
check('repetition is under 60% of rejections',
  repeatShare < 0.6, `${Math.round(repeatShare * 100)}% (${repeatRejects}/${rejects.length})`);

const showRate = generated.length ? shown.length / generated.length : 0;
check('at least a third of written tips reach the player',
  showRate >= 0.33, `${Math.round(showRate * 100)}% (${shown.length}/${generated.length})`);

const perHour = minutes > 0 ? (shown.length / minutes) * 60 : 0;
check('the player hears a tip at least every 90s',
  perHour >= 40, `${perHour.toFixed(0)} tips/hour`, 'warn');

// Death reviews are the most valuable tip and the easiest to get wrong.
const deathWrongSpot = rejects.filter((r) => /said the death was at|as the death spot/.test(r.reject)).length;
const deathShown = shown.filter((t) => /\byou died\b/i.test(t)).length;
check('death locations are mostly right',
  deathWrongSpot <= Math.max(2, deathShown), `${deathWrongSpot} wrong vs ${deathShown} shown`, 'warn');

// One idea repeated is the difference between coaching and a slogan.
const themes = [['trade partner', /trade partner|to trade\b/i], ['alone', /\balone\b|\bsolo\b/i],
  ['hold tight', /hold[^.]*tight|stay tight|tight to/i], ['wait for team', /wait for|until your team/i]];
const dominant = themes.map(([n, re]) => [n, shown.filter((t) => re.test(t)).length])
  .sort((a, b) => b[1] - a[1])[0] || ['none', 0];
check('no single theme dominates what the player sees',
  !shown.length || dominant[1] / shown.length < 0.5,
  `"${dominant[0]}" in ${dominant[1]}/${shown.length}`);

// ── Report ──────────────────────────────────────────────────────────────────
for (const r of results) {
  const tag = r.ok ? 'ok  ' : (r.severity === 'warn' ? 'WARN' : 'FAIL');
  console.log(`${tag}  ${r.name}${r.ok || !r.detail ? '' : `\n        ${String(r.detail).slice(0, 110)}`}`);
}

const top = {};
for (const r of rejects) top[r.reject] = (top[r.reject] || 0) + 1;
const ranked = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (ranked.length) {
  console.log('\ntop reasons tips were dropped:');
  for (const [reason, n] of ranked) console.log(`  ${String(n).padStart(3)}x ${reason}`);
}

console.log(problems ? `\n${problems} check(s) failed` : '\nall checks passed');
process.exit(problems ? 1 : 0);
