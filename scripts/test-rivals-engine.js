'use strict';

/**
 * The Rivals engine's cadence and its refusal rules, with no network.
 *
 * The whole design rests on capturing on state change rather than on a clock,
 * and the risks that creates are the ones tested here: a protocol word reaching
 * a player, a draft being re-read every few seconds because the cooldown never
 * armed, or the same sentence arriving twice in a session that only shows three.
 *
 * Run: npm run test:rivalsengine
 */
const path = require('path');
const { RivalsEngine, PROBE_MS, DRAFT_COOLDOWN_MS } =
  require(path.join(__dirname, '..', 'src', 'main', 'services', 'rivals-engine.js'));

let fails = 0;
const ok = (cond, what) => { if (!cond) { fails++; console.log(`FAIL  ${what}`); } else console.log(`ok    ${what}`); };

/** An engine wired to a fake capture, with the scheduler and emitter observed. */
function harness() {
  const e = new RivalsEngine({ getKey: () => 'KEY', capture: async () => 'IMAGEDATA', log: () => {} });
  const tips = [];
  const delays = [];
  e.on('tip', (t) => tips.push(t));
  e.schedule = (ms) => delays.push(ms);      // never actually set a timer
  e.running = true;
  return { e, tips, delays };
}

// ── Protocol words never reach a player ─────────────────────────────────────
for (const word of ['SKIP', 'LOBBY', 'skip', ' lobby ']) {
  const { e, tips } = harness();
  e.offer(word, {}, 'ai');
  // offer() is the last gate; tick() filters earlier, but a protocol word must
  // not survive even if it somehow gets this far.
  const leaked = tips.some((t) => /^(skip|lobby)$/i.test(t.text.trim()));
  ok(!leaked || tips.length === 0, `${JSON.stringify(word)} does not reach the player as a tip`);
}

// ── Repetition, which matters MORE here than in Valorant ────────────────────
{
  const { e, tips } = harness();
  e.offer('Lock a Strategist, nobody on your team is healing.', { phase: 'draft' }, 'ai');
  e.offer('Lock a Strategist, nobody on your team is healing.', { phase: 'draft' }, 'ai');
  ok(tips.length === 1, `an identical repeat is dropped (${tips.length} shown)`);

  e.offer('Lock a Strategist because nobody is healing on your team.', { phase: 'draft' }, 'ai');
  ok(tips.length === 1, 'a reworded repeat is dropped too');

  e.offer('Take a Vanguard, there is no front line to hold the point.', { phase: 'draft' }, 'ai');
  ok(tips.length === 2, `genuinely different advice still gets through (${tips.length} shown)`);
}
{
  const { e, tips } = harness();
  e.offer('', {}, 'ai');
  e.offer('   ', {}, 'ai');
  ok(tips.length === 0, 'empty tips are never emitted');
}

// ── Tips carry what the overlay and the log need ────────────────────────────
{
  const { e, tips } = harness();
  e.offer('Lock a Vanguard, there is no front line.', { phase: 'draft' }, 'ai');
  ok(tips[0].game === 'rivals', 'the tip says which game it came from');
  ok(tips[0].phase === 'draft', 'and which phase it was about');
  ok(tips[0].source === 'ai', 'and where it came from');
}

// ── Cadence ─────────────────────────────────────────────────────────────────
ok(PROBE_MS < 10000, `the probe is faster than the Valorant loop (${PROBE_MS}ms), or drafts are missed`);
ok(DRAFT_COOLDOWN_MS > PROBE_MS * 5, 'a read draft goes quiet rather than re-reading a countdown');

// ── The snapshot the diagnostics panel reads ────────────────────────────────
{
  const { e } = harness();
  e.lastState = { phase: 'draft', map: 'Klyntar', suggested: 'SUGGESTED PICK: STRATEGIST', locked: ['Tank', 'DPS', 'DPS'] };
  const s = e.snapshot();
  ok(s.game === 'rivals', 'the snapshot names the game');
  ok(s.locked.join() === 'Vanguard,Duelist,Duelist', `roles are normalised in the snapshot (${s.locked.join()})`);
  ok(s.advice && s.advice.role === 'Strategist', `and it carries the draft advice (${s.advice && s.advice.role})`);
}
{
  // An unreadable roster must produce no advice rather than a confident guess.
  const { e } = harness();
  e.lastState = { phase: 'draft', locked: ['Sorcerer', 'DPS'] };
  ok(e.snapshot().advice === null, 'an unreadable roster yields no advice');
}
{
  const { e } = harness();
  ok(e.snapshot().advice === null, 'a fresh engine that has read nothing advises nothing');
}

// ── The draft gate, which runs HERE and not on the server ───────────────────
// Only server/ is deployed, so a route reaching into src/ for these rules
// resolves in development and throws on Railway. check:server-boot caught that,
// and the split it forced is the one the Valorant path already uses: coach.js
// parses, coaching-engine.js decides.
{
  const { e } = harness();
  const draft = { phase: 'draft', locked: ['Vanguard', 'Duelist', 'Duelist'], suggested: 'SUGGESTED PICK: STRATEGIST' };

  const enemy = e.vet('They have three dive heroes, take a Strategist.', draft);
  ok(enemy !== 'They have three dive heroes, take a Strategist.', 'an enemy claim is replaced, not shown');
  ok(/Strategist/.test(enemy), `and the replacement still gives the right role (${enemy})`);

  const wrongRole = e.vet('Take a Vanguard, your team needs a front line.', draft);
  ok(/Strategist/.test(wrongRole), 'a tip naming the wrong role is replaced with the right one');

  const good = 'Nobody on your team is healing, so lock a Strategist.';
  ok(e.vet(good, draft) === good, 'a clean tip passes through untouched');

  // A roster the guard cannot trust yields no replacement either, because a
  // fabricated fallback is no better than a fabricated tip.
  ok(e.vet('Lock a Strategist.', { phase: 'draft', locked: ['Vanguard', 'Sorcerer'] }) === '',
    'an unreadable roster produces no tip at all, not a guessed one');

  // Reviews are about the player's own scoreboard row, so there is no roster to
  // gate on and gating them would silence every post match tip.
  const review = 'You died 11 times, so look for a trade before you commit.';
  ok(e.vet(review, { phase: 'scoreboard' }) === review, 'review tips are not gated on a roster');
  ok(e.vet(review, null) === review, 'a tip with no context is passed through rather than dropped');
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
{
  const e = new RivalsEngine({ getKey: () => null, capture: async () => null, log: () => {} });
  const states = [];
  e.on('status', (s) => states.push(s));
  e.start();
  ok(e.running === true && states[0].running === true, 'start emits a running status');
  e.stop();
  ok(e.running === false && states[states.length - 1].running === false, 'stop emits a stopped status');
  e.stop();
  ok(true, 'stopping twice does not throw');
}

// ── Feature flags decide which question is even asked ───────────────────────
// The draft read gets teammate roles wrong, so it ships OFF. Not asking is
// stronger than gating the answer: a request never made cannot produce a wrong
// tip, and it does not spend a vision call only to throw the result away.
//
// This block is LAST and asynchronous, and the summary below lives inside its
// continuation. Written first as a bare top level `return`, which in CommonJS
// exits the module: every later check silently never ran, the summary never
// printed, and the file still exited 0. A test that reports success without
// running is worse than one that fails.
{
  const routes = [];
  const e = new RivalsEngine({
    getKey: () => 'KEY',
    capture: async () => 'IMG',
    log: () => {},
    features: { review: true, draft: false },
  });
  e.running = true;
  e.schedule = () => {};

  // Stand in for the network, so which route the engine chose is observable
  // without one.
  const api = require(path.join(__dirname, '..', 'src', 'main', 'services', 'api-client.js'));
  const realPost = api.post;
  api.post = async (route) => { routes.push(route); return { ok: true, data: { tip: 'LOBBY', context: {} } }; };

  Promise.all([e.tick(), e.tick()]).then(() => {
    api.post = realPost;
    ok(routes.length > 0, 'the engine actually made a request');
    ok(routes.every((r) => /review/.test(r)),
      `with draft off, every request is a review (${[...new Set(routes)].join(', ')})`);
    ok(!routes.some((r) => /draft/.test(r)), 'and the draft route is never called at all');

    console.log(fails ? `\n${fails} failure(s)` : '\nall rivals engine checks passed');
    process.exit(fails ? 1 : 0);
  });
}
