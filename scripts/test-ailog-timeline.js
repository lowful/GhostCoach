'use strict';

/**
 * Which map a logged session was actually played on.
 *
 * The reason this needs testing at all is that the model's map read is wrong
 * often enough to be dangerous, but not often enough to look wrong. Real
 * sessions logged "Sunset x119, Bind x3, Lotus x3" for one continuous match, so
 * anything that trusts a frame's map read splits one game into seven and then
 * states each fragment confidently.
 *
 * So the cases below are mostly about what must NOT be marked.
 *
 * Run: npm run test:ailog-timeline
 */
const path = require('path');
const fs = require('fs');
const tl = require(path.join(__dirname, '..', 'src', 'main', 'services', 'ai-log-timeline.js'));

let fails = 0;
const ok = (cond, what) => { if (!cond) { fails++; console.log(`FAIL  ${what}`); } else console.log(`ok    ${what}`); };

// Callouts unique to one map each, taken from the generated data, so the label
// fingerprint has something real to work with.
const LABELS = {
  Bind:   ['Hookah', 'Bath', 'Showers', 'Lamps', 'Teleporter'],
  Lotus:  ['Waterfall', 'Mound', 'Rubble', 'Gravel', 'A Site'],
  Sunset: ['Boba', 'A Link', 'Mid Courtyard', 'B Market', 'A Elbow'],
  Abyss:  ['Library', 'A Site', 'Mid', 'B Site'],
};

/** n frames on one map, with a running score, and its own printed callouts. */
function frames(map, n, startScore = 0, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const total = startScore + Math.floor(i / 3);
    out.push({
      i, at: 0, frame: 'x.jpg',
      state: {
        map: opts.mapRead === undefined ? map : opts.mapRead,
        locLabel: LABELS[map][i % LABELS[map].length],
        teamScore: opts.noScore ? undefined : Math.ceil(total / 2),
        enemyScore: opts.noScore ? undefined : Math.floor(total / 2),
      },
      shown: null,
    });
  }
  return out;
}

// ── One match, one map, with the model flickering ───────────────────────────
// This is the shape every real session in the log has.
{
  const recs = frames('Sunset', 60);
  recs[3].state.map = 'Bind';        // the flickers that broke the first attempt
  recs[4].state.map = 'Bind';
  recs[30].state.map = 'Lotus';
  recs[47].state.map = 'Haven';
  const segs = tl.segments(recs);
  ok(segs.length === 1, `a flickering map read stays ONE segment (got ${segs.length})`);
  ok(segs[0].map === 'Sunset', `the plurality map wins (${segs[0].map})`);
  ok(segs[0].confirmed === true, 'model and labels agreeing marks it confirmed');
  ok(tl.mapsPlayed(recs).join() === 'Sunset', 'the session label names one map, not four');
}

// Two consecutive misreads at the very start, which is how a real session opened.
{
  const recs = frames('Sunset', 40);
  recs[0].state.map = 'Bind';
  recs[1].state.map = 'Bind';
  ok(tl.segments(recs).length === 1, 'two opening misreads do not create a segment');
}

// ── A real map change, marked by the scoreboard resetting ───────────────────
{
  const recs = [...frames('Bind', 30, 20), ...frames('Lotus', 30, 0)];
  const segs = tl.segments(recs);
  ok(segs.length === 2, `a score reset plus a new map gives two segments (got ${segs.length})`);
  ok(segs[0].map === 'Bind' && segs[1].map === 'Lotus', `and names them in order (${segs.map((s) => s.map).join(' then ')})`);
  ok(segs[1].from === 30, `the change is marked at the frame it happened (${segs[1].from})`);
  ok(segs.every((s) => s.confirmed), 'both segments are confirmed by both witnesses');
}

// A score reset on the SAME map is a new match but not a map change, so the
// timeline must not mark it: nothing changed that a marker would be pointing at.
{
  const recs = [...frames('Bind', 25, 20), ...frames('Bind', 25, 0)];
  ok(tl.segments(recs).length === 1, 'a new match on the same map is not a map change');
}

// ── A real map change the scoreboard missed ─────────────────────────────────
{
  const recs = [...frames('Bind', 30, 0, { noScore: true }), ...frames('Lotus', 30, 0, { noScore: true })];
  const segs = tl.segments(recs);
  ok(segs.length === 2, `a sustained change with agreeing labels is caught without a score (got ${segs.length})`);
  ok(segs[1].map === 'Lotus' && segs[1].from === 30, 'and is cut at the right frame');
}

// The same thing, but the labels keep saying Bind: one witness is not enough.
{
  const recs = frames('Bind', 60, 0, { noScore: true });
  for (let i = 20; i < 60; i++) recs[i].state.map = 'Lotus';   // model changes, labels do not
  const segs = tl.segments(recs);
  ok(segs.length === 1, 'the model alone cannot move the map without the labels agreeing');
  ok(segs[0].map === 'Bind', `the labels decide, so it stays Bind (${segs[0].map})`);
  ok(segs[0].confirmed === false, 'and it is reported UNCONFIRMED rather than asserted');
}

// A four-frame blip is under MIN_RUN and must never split, whatever it claims.
{
  const recs = frames('Sunset', 40, 0, { noScore: true });
  for (let i = 10; i < 14; i++) recs[i].state.map = 'Lotus';
  ok(tl.segments(recs).length === 1, `a ${tl.MIN_RUN - 1} frame run is too short to split`);
}

// ── The scoreboard is not trusted blindly either ────────────────────────────
// One frame misreading the score as 0-0 mid match would otherwise cut the
// session in half, which is the same class of bug as the map flicker.
{
  const recs = frames('Bind', 40, 20);
  recs[20].state.teamScore = 0;
  recs[20].state.enemyScore = 0;
  ok(tl.matchStarts(recs).length === 1, 'a single 0-0 misread does not start a new match');
  ok(tl.segments(recs).length === 1, 'and does not split the session');
}
{
  const recs = frames('Bind', 40, 20);
  for (let i = 20; i < 40; i++) { recs[i].state.teamScore = 0; recs[i].state.enemyScore = 0; }
  ok(tl.matchStarts(recs).length === 2, 'a reset that holds IS a new match');
}

// Unreadable scores are common during a killcam and must never split anything.
{
  const recs = frames('Bind', 40, 20);
  for (let i = 15; i < 25; i++) { delete recs[i].state.teamScore; delete recs[i].state.enemyScore; }
  ok(tl.matchStarts(recs).length === 1, 'an unreadable scoreboard does not start a match');
}

// ── Degenerate input ────────────────────────────────────────────────────────
ok(tl.segments([]).length === 0, 'an empty session has no segments');
ok(tl.segments(null).length === 0, 'a missing session has no segments');
{
  const recs = frames('Bind', 5).map((r) => ({ ...r, state: {} }));
  const segs = tl.segments(recs);
  ok(segs.length === 1 && segs[0].map === null && segs[0].confirmed === false,
    'a session the AI never read reports an unknown map rather than guessing');
}

// ── Against the real log, if there is one ───────────────────────────────────
// Every session recorded so far is a single match on a single map, and each was
// misreported as two or three maps before this existed.
const root = path.join(process.env.APPDATA || '', 'GhostCoach 2.0', 'ai-log');
if (fs.existsSync(root)) {
  for (const id of fs.readdirSync(root).filter((f) => /^session-/.test(f))) {
    const p = path.join(root, id, 'log.json');
    if (!fs.existsSync(p)) continue;
    let recs = [];
    try { recs = JSON.parse(fs.readFileSync(p, 'utf8')).records || []; } catch { continue; }
    if (recs.length < 20) continue;
    const segs = tl.segments(recs);
    const raw = new Set(recs.map((r) => r.state && r.state.map).filter(Boolean)).size;
    ok(segs.every((s) => s.confirmed),
      `${id.slice(8, 24)}: ${recs.length} frames, ${raw} maps read, ${segs.length} confirmed segment(s): ${segs.map((s) => s.map).join(' then ')}`);
  }
}

console.log(fails ? `\n${fails} failure(s)` : '\nall ai-log timeline checks passed');
process.exit(fails ? 1 : 0);
