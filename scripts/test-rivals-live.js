'use strict';

/**
 * Live Rivals tips: the moment gate, the hero table and the switch call.
 *
 * The assertions that matter most here are the NEGATIVE ones. This feature
 * tells a player to abandon the hero they chose, so being wrong is expensive in
 * a way that being quiet is not, and almost every rule in it exists to stop it
 * speaking rather than to make it speak.
 */
const moments = require('../src/shared/rivals-moments');
const heroes = require('../server/services/rivals-heroes');
const counters = require('../server/services/rivals-counters');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); return; }
  console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  failures++;
}

// ── The hero table ──────────────────────────────────────────────────────────
console.log('[rivals] hero traits');
{
  const ROLES = ['Vanguard', 'Duelist', 'Strategist'];
  const AIMS = ['hitscan', 'projectile', 'melee'];
  const AIRS = ['flight', 'leap', 'ground'];
  const ARCHES = ['dive', 'poke', 'brawl'];
  const bad = Object.entries(heroes.HEROES).filter(([, h]) =>
    !ROLES.includes(h.role) || !AIMS.includes(h.aim) || !AIRS.includes(h.air) || !ARCHES.includes(h.arch));
  check('every entry uses the known vocabulary', bad.length === 0, bad.map(([n]) => n).join(', '));

  check('lookup works', heroes.traits('Iron Man').air === 'flight');
  check('lookup is case and space insensitive', heroes.traits('  iron   man ').air === 'flight');
  check('aliases resolve', heroes.traits('Bucky').name === 'winter soldier');
  check('alias: Jeff', heroes.traits('Jeff').name === 'jeff the land shark');

  // THE IMPORTANT ONE. A hero we cannot vouch for must come back null so every
  // rule downstream stays quiet about it.
  check('an unknown hero returns null', heroes.traits('Some New Season 12 Hero') === null);
  check('empty input returns null', heroes.traits('') === null && heroes.traits(undefined) === null);

  const aliasTargetsExist = Object.values(heroes.ALIASES).every((v) => heroes.HEROES[v]);
  check('every alias points at a real entry', aliasTargetsExist);

  // PENDING is the roster we know exists but have not classified. It must not
  // overlap HEROES, or a hero would look both known and unknown, and every
  // entry in it must still resolve to null so the silence rule holds.
  const overlap = heroes.PENDING.filter((n) => heroes.HEROES[heroes.normalise(n)]);
  check('pending never overlaps classified', overlap.length === 0, overlap.join(', '));
  const leaky = heroes.PENDING.filter((n) => heroes.traits(n) !== null);
  check('every pending hero still returns null', leaky.length === 0, leaky.join(', '));

  // The two lists together are the roster. META says 53 for Season 9.5, and if
  // that stops matching then one of the two is out of date, which is exactly
  // the drift this split exists to make visible.
  const total = Object.keys(heroes.HEROES).length + heroes.PENDING.length;
  const meta = require('../server/services/rivals-knowledge').META.heroCount;
  check('classified plus pending equals the known roster', total === meta,
    total + ' vs META ' + meta);
}

// ── The switch call ─────────────────────────────────────────────────────────
console.log('\n[rivals] switch advice');
{
  // The case the whole feature was asked for: flying into hitscan.
  const flying = counters.switchAdvice({
    mine: 'Iron Man',
    enemies: ['The Punisher', 'Black Widow', 'Groot'],
    score: { kills: 1, deaths: 4 },
  });
  check('flying into two hitscan fires', !!flying && flying.reason === 'flight-into-hitscan',
    JSON.stringify(flying));
  check('the tip names the threats', !!flying && /Punisher/.test(flying.text) && /Black Widow/.test(flying.text),
    flying && flying.text);

  // One hitscan is the normal state of a match.
  check('ONE hitscan does not fire', counters.switchAdvice({
    mine: 'Iron Man', enemies: ['The Punisher', 'Groot'], score: { kills: 1, deaths: 4 },
  }) === null);

  // Doing well beats theory.
  check('winning suppresses the call', counters.switchAdvice({
    mine: 'Iron Man', enemies: ['The Punisher', 'Black Widow'], score: { kills: 9, deaths: 2 },
  }) === null);

  // A grounded hero is not flying into anything.
  check('a grounded hero gets no flight call', counters.switchAdvice({
    mine: 'The Punisher', enemies: ['Black Widow', 'Hela'], score: { kills: 0, deaths: 3 },
  }) === null);

  // Unknown heroes are simply not counted.
  check('unknown enemies do not count toward the pattern', counters.switchAdvice({
    mine: 'Iron Man', enemies: ['Nobody', 'Someone Else', 'The Punisher'], score: { kills: 0, deaths: 3 },
  }) === null);
  check('an unknown OWN hero says nothing', counters.switchAdvice({
    mine: 'Unreleased Hero', enemies: ['The Punisher', 'Black Widow'], score: { kills: 0, deaths: 5 },
  }) === null);
  check('no enemies says nothing', counters.switchAdvice({ mine: 'Iron Man', enemies: [] }) === null);

  // Archetype rules.
  const dive = counters.switchAdvice({
    mine: 'Spider-Man', enemies: ['Groot', 'The Thing', 'Luna Snow'], score: { kills: 0, deaths: 3 },
  });
  check('diving into a brawl comp fires', !!dive && dive.reason === 'dive-into-brawl', JSON.stringify(dive));

  const poke = counters.switchAdvice({
    mine: 'Hawkeye', enemies: ['Spider-Man', 'Black Panther', 'Magik'], score: { kills: 1, deaths: 4 },
  });
  check('poking into a dive comp fires', !!poke && poke.reason === 'poke-into-dive', JSON.stringify(poke));
}

// ── Once per match ──────────────────────────────────────────────────────────
console.log('\n[rivals] the switch gate');
{
  const gate = counters.createSwitchGate();
  const p = { mine: 'Iron Man', enemies: ['The Punisher', 'Black Widow'], score: { kills: 0, deaths: 4 } };
  check('first call is advised', gate.advise(p) !== null);
  check('the same reason is never repeated', gate.advise(p) === null);
  gate.reset();
  check('a new match says it again', gate.advise(p) !== null);
}

// ── The moment gate ─────────────────────────────────────────────────────────
console.log('\n[rivals] moments');
{
  check('death is recognised', moments.momentFrom('RESPAWNING IN 5') === 'death');
  check('kill cam is a death', moments.momentFrom('kill cam') === 'death');
  check('team wipe is recognised', moments.momentFrom('TEAM WIPE!') === 'teamWipe');
  check('objective is recognised', moments.momentFrom('Point captured') === 'objective');
  check('round start is recognised', moments.momentFrom('Round 2') === 'roundStart');

  // Mid fight is NOT a moment, which is the entire point of the file.
  check('an ordinary fight frame is not a moment',
    moments.momentFrom('Iron Man is shooting at Groot near the payload') === null,
    JSON.stringify(moments.momentFrom('Iron Man is shooting at Groot near the payload')));
  check('empty text is not a moment', moments.momentFrom('') === null);

  // Priority: a death and a team wipe are the same instant.
  check('death outranks team wipe in one frame',
    moments.momentFrom('TEAM WIPE, respawning in 4') === 'death');
}

// ── The budget ──────────────────────────────────────────────────────────────
console.log('\n[rivals] the tip budget');
{
  const g = moments.createMomentGate({ maxPerMatch: 2, minGapMs: 1000 });
  let t = 0;
  check('closed until a moment opens', g.allows(t) === false);

  g.observe('respawning in 5', t);
  check('open right after a death', g.allows(t) === true);
  g.note(t);
  check('one tip per moment', g.allows(t) === false);

  t += 500;
  g.observe('point captured', t);
  check('too soon after the last tip', g.allows(t) === false, 'gap not enforced');

  t += 1200;
  g.observe('TEAM WIPE', t);
  check('allowed once the gap has passed', g.allows(t) === true);
  g.note(t);

  t += 5000;
  g.observe('respawning in 5', t);
  check('the per match budget is final', g.allows(t) === false, JSON.stringify(g.state));

  // A window that has expired does not still count as open.
  const g2 = moments.createMomentGate({ minGapMs: 0 });
  g2.observe('respawning in 5', 0);
  check('the window expires', g2.allows(moments.MOMENTS.death.windowMs + 1) === false);
}

if (failures) {
  console.log('\nFAIL: ' + failures + ' live-Rivals check(s) failed');
  process.exit(1);
}
console.log('\nPASS: it speaks only at readable moments, and only about heroes it knows');
