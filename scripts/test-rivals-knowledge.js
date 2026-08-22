'use strict';

/**
 * What the Rivals coach knows, and what it must stop claiming once it goes off.
 *
 * The split this file guards is durable game theory versus dated hero strength.
 * Valorant map knowledge stays true for years; Rivals rebalances constantly, and
 * a coach confidently naming last season's best pick is worse than one that says
 * nothing about heroes at all. So the tier list expires and the fundamentals do
 * not, and the coach is built on the half that never rots.
 *
 * Run: npm run test:rivalsknowledge
 */
const path = require('path');
const k = require(path.join(__dirname, '..', 'server', 'services', 'rivals-knowledge.js'));

let fails = 0;
const ok = (cond, what) => { if (!cond) { fails++; console.log(`FAIL  ${what}`); } else console.log(`ok    ${what}`); };

// ── The counter triangle must be a real triangle ────────────────────────────
// It is the single most useful durable fact in the game, and it is only useful
// if it is consistent. A typo here teaches the player a matchup backwards.
{
  const ids = Object.keys(k.ARCHETYPES);
  ok(ids.length === 3, `there are exactly three archetypes (${ids.join(', ')})`);
  for (const [id, a] of Object.entries(k.ARCHETYPES)) {
    ok(a.beats !== id && a.losesTo !== id, `${a.name} does not beat or lose to itself`);
    ok(k.ARCHETYPES[a.beats].losesTo === id, `${a.name} beats ${a.beats}, and ${a.beats} agrees it loses to ${id}`);
    ok(k.ARCHETYPES[a.losesTo].beats === id, `${a.name} loses to ${a.losesTo}, and ${a.losesTo} agrees it beats ${id}`);
    ok(a.why && a.why.length > 30, `${a.name} explains WHY rather than just asserting`);
  }
}

// ── Every role is covered, with the parts a tip actually needs ──────────────
{
  const roles = Object.keys(k.ROLE_CRAFT);
  ok(roles.join() === 'Vanguard,Duelist,Strategist', `all three roles present (${roles.join(', ')})`);
  for (const [r, c] of Object.entries(k.ROLE_CRAFT)) {
    for (const field of ['job', 'position', 'mistake', 'reads']) {
      ok(typeof c[field] === 'string' && c[field].length > 20, `${r} has a real ${field}`);
    }
  }
}

// ── The dated snapshot EXPIRES ──────────────────────────────────────────────
// The whole point of separating volatile from durable. Past the horizon the
// hero names are withheld rather than hedged, on the same principle as the
// callout gate: do not name a thing you cannot verify.
{
  const day = 86400000;
  ok(k.metaIsFresh(k.META.capturedAt), 'the snapshot is fresh on the day it was captured');
  ok(k.metaIsFresh(k.META.capturedAt + (k.META_MAX_AGE_DAYS - 1) * day), 'and just inside the horizon');
  ok(!k.metaIsFresh(k.META.capturedAt + (k.META_MAX_AGE_DAYS + 1) * day), 'and stale just outside it');

  const fresh = k.block({ now: k.META.capturedAt });
  const stale = k.block({ now: k.META.capturedAt + 400 * day });
  ok(/Peni Parker/.test(fresh), 'a fresh block names the strong heroes');
  ok(!/Peni Parker/.test(stale), 'a STALE block names no hero at all');
  ok(!/tier|win rate|strongest/i.test(k.metaBlock(k.META.capturedAt + 400 * day)), 'and makes no strength claim');

  // Losing the snapshot must not gut the coach. This is what makes the design
  // survivable: the durable half carries it alone.
  ok(stale.length > 2000, `the coach still knows plenty with no meta at all (${stale.length} chars)`);
  ok(/Beats poke/.test(stale), 'including the counter triangle');
  ok(/Vanguard\. Job:/.test(stale), 'and what every role is for');
}

// ── The snapshot must never become an instruction ───────────────────────────
// A tier list that reads as an order produces "switch to Peni" regardless of
// whether the player has ever played her, which is the opposite of coaching.
{
  const m = k.metaBlock(k.META.capturedAt);
  ok(/NEVER tell the player to switch/i.test(m), 'the meta block forbids switching on the strength of the list');
  ok(/never claim a hero is weak/i.test(m), 'and forbids calling a hero weak');
  ok(/own results.*outrank/i.test(m), "and says the player's own results outrank it");
}

// ── Nothing here may carry a dash, since the model copies its punctuation ───
for (const [name, text] of [['fundamentals', k.fundamentals()], ['meta', k.metaBlock(k.META.capturedAt)], ['block', k.block()]]) {
  ok(!/[—–]/.test(text), `the ${name} block has no em or en dashes`);
}

// ── Determinism, because a prompt that changes per call is untestable ───────
ok(k.block({ now: k.META.capturedAt }) === k.block({ now: k.META.capturedAt }),
  'block() is deterministic for the same moment');

// ── Aim model, which is what makes an accuracy number mean anything ─────────
{
  ok(/travel time/i.test(k.AIM_MODEL.projectile), 'projectile is defined by travel time');
  ok(/instant/i.test(k.AIM_MODEL.hitscan), 'hitscan is defined by being instant');
  ok(/do not coach the accuracy/i.test(k.fundamentals()),
    'and the coach is told NOT to judge accuracy when it cannot tell which applies');
}

console.log(fails ? `\n${fails} failure(s)` : '\nall rivals knowledge checks passed');
process.exit(fails ? 1 : 0);
