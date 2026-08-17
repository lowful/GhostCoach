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

// ── Deaths ──────────────────────────────────────────────────────────────────
// Every tell below is copied verbatim from a real logged session, and the ones
// asserted as alive were each confirmed by opening the screenshot.
const at = (tell, extra = {}) => ({ state: { aliveTell: tell, ...extra }, shown: null });
const dead = (tell, extra) => at(tell, extra);

{
  // The verdict on single frames, which is where both errors live.
  const v = (t, e) => tl.aliveVerdict({ aliveTell: t, ...(e || {}) });
  ok(v('spectating Fade with SWITCH PLAYER text bottom left') === 'dead', 'SWITCH PLAYER means dead');
  ok(v('Killed by Clove, spectating own death') === 'dead', 'a killcam means dead');
  ok(v('own HP 74 and Bandit bottom center') === 'alive', 'seeing your own hud means alive');

  // The screenshot for this frame shows a living player at 100 HP with the
  // scoreboard open. The server used to force it dead on the word "spectating"
  // alone, and the flag in the stored log is still wrong, so the evidence in the
  // tell has to win over the flag.
  ok(v('own HP 100 and knife bottom center, spectating scoreboard', { playerAlive: false }) === 'alive',
    'spectating the SCOREBOARD is not spectating a player');

  // The reverse trap: a health number read off the spectated teammate's hud.
  ok(v('Spectating THINKtwise with 87 HP and Vandal bottom center', { playerHp: 87, playerAlive: true }) === 'dead',
    "a teammate's health number does not make you alive");
}

{
  // A lone dead frame between living ones. Both of these were opened: the player
  // is mid round holding their own weapon, with a teammate merely visible.
  const recs = [
    at('own HP 100 and Vandal bottom center'),
    at('own HP 100 and Vandal bottom center'),
    dead('Spectating teammate at C Garage with Sheriff'),
    at('own HP 87 and Vandal bottom center'),
    at('own HP 87 and Vandal bottom center'),
  ];
  ok(tl.deaths(recs).length === 0, 'a single unproven dead frame is not a death');
}
{
  // The same shape, but the game printed SWITCH PLAYER, so it is real.
  const recs = [
    at('own HP 100 and Vandal bottom center'),
    dead('Spectating Reyna with SWITCH PLAYER text bottom left'),
    at('own HP 100 and knife bottom center'),
  ];
  ok(tl.deaths(recs).length === 1, 'a single PROVEN dead frame is a death');
}
{
  // Unproven but sustained: dying ends your round, so the spectator hud stays up.
  const recs = [
    at('own HP 100 and Vandal bottom center'),
    dead('Spectating Fade, own loadout replaced by teammate name'),
    dead('spectating Fade with no own HP'),
    at('own HP 100 and knife bottom center'),
  ];
  const d = tl.deaths(recs);
  ok(d.length === 1 && d[0].at === 1, 'an unproven death that LASTS counts, and is placed at its first frame');
}
{
  // Two deaths in a row must not merge, and a review only counts for its own.
  const recs = [
    at('own HP 100 and knife bottom center'),
    dead('Killed by Clove, spectating own death'),
    dead('Spectating Fade, own loadout not visible'),
    at('own HP 100 and knife bottom center'),
    at('own HP 100 and Vandal bottom center'),
    dead('spectating Fade with SWITCH PLAYER text bottom left'),
    dead('Spectating iphone5 with SWITCH PLAYER'),
  ];
  recs[1].shown = { text: 'you walked out alone', death: true };
  const d = tl.deaths(recs);
  ok(d.length === 2, `two separate deaths stay separate (got ${d.length})`);
  ok(d[0].reviewed === true && d[1].reviewed === false, 'reviewed is tracked per death');
  ok(d[0].killedBy === 'Clove', `the killer is read when it is stated (${d[0].killedBy})`);
}
{
  // Joining mid death still counts it, rather than reporting a session with a
  // visible death review as having had no deaths.
  const recs = [
    dead('Spectating Fade with SWITCH PLAYER text bottom left'),
    dead('Spectating Fade, killed by Clove'),
    at('own HP 100 and knife bottom center'),
  ];
  const d = tl.deaths(recs);
  ok(d.length === 1 && d[0].joinedInProgress === true, 'a session opening mid death still records it');
}
{
  // The stale combat report. "KILLED BY CLOVE" stays on screen through the end
  // of the round and into the next buy phase, and three real frames carried it
  // while the player was alive at full health.
  const recs = [
    at('own HP 100 and knife bottom center, KILLED BY CLOVE panel on right', { killFeed: 'Killed by Clove' }),
    at('own HP 100 and knife bottom center, combat report visible', { killFeed: 'Killed by Clove' }),
    at('own HP 100 and Vandal bottom center', { killFeed: 'Killed by Clove' }),
  ];
  ok(tl.deaths(recs).length === 0, 'a leftover KILLED BY panel is not a death');
}
{
  ok(tl.deaths([]).length === 0, 'an empty session has no deaths');
  ok(tl.deaths(null).length === 0, 'a missing session has no deaths');
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
    // A player dies at most once per round, so this is a hard ceiling and
    // breaking it means a run of frames was read as the wrong state.
    const san = tl.deathSanity(recs);
    ok(!san.overCeiling,
      `${id.slice(8, 24)}: ${san.deaths} deaths in ${san.rounds} rounds, ${san.reviewed} reviewed`);
  }
}

console.log(fails ? `\n${fails} failure(s)` : '\nall ai-log timeline checks passed');
process.exit(fails ? 1 : 0);
