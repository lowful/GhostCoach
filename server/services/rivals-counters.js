'use strict';

/**
 * Should this player switch, and why.
 *
 * The one line of advice a hero shooter can give that a Valorant coach cannot:
 * you picked wrong for what you are looking at, and you can fix it at the next
 * respawn. That is worth saying, and it is worth saying RARELY, which is what
 * most of the rules below are actually for.
 *
 * FOUR THINGS IT WILL NOT DO:
 *
 * 1. It will not speak about a hero it does not know. rivals-heroes.js is
 *    deliberately partial and returns null for anything unverified, and every
 *    rule here treats null as "say nothing". A confident switch call about a
 *    flyer who is not flying is worse than silence.
 * 2. It will not fire on one enemy. A single hitscan pick is the normal state
 *    of a match; two of them aiming at you is a reason to move.
 * 3. It will not tell you to switch off a hero you are winning on. Impact beats
 *    theory, so a positive scoreline suppresses the call entirely.
 * 4. It will not repeat. Once per match per reason, because a coach who says it
 *    twice is nagging and a player who ignored it once has decided.
 */

const heroes = require('./rivals-heroes');
const { ARCHETYPES } = require('./rivals-knowledge');

/** Two of a thing is a pattern; one is a coincidence. */
const PATTERN = 2;

/**
 * @param {object} p
 * @param {string} p.mine        the hero the player is on
 * @param {string[]} p.enemies   enemy heroes read off the scoreboard or feed
 * @param {object} [p.score]     { kills, deaths } this life or this match
 * @returns {{reason: string, text: string}|null}
 */
function switchAdvice(p) {
  const me = heroes.traits(p && p.mine);
  if (!me) return null;                       // unknown hero, say nothing

  const enemy = (p.enemies || [])
    .map((n) => heroes.traits(n))
    .filter(Boolean);                          // unknown enemies simply do not count
  if (!enemy.length) return null;

  // Doing well beats any theory about matchups.
  const s = p.score || {};
  const winning = Number(s.kills) >= Number(s.deaths) + 2;
  if (winning) return null;

  // ── Flying into hitscan ────────────────────────────────────────────────
  // The clearest counter in the game and the one worth leading with: a flyer
  // is a large target on a predictable path with nothing to hide behind.
  if (me.air === 'flight') {
    const hitscan = enemy.filter((e) => e.aim === 'hitscan');
    if (hitscan.length >= PATTERN) {
      return {
        reason: 'flight-into-hitscan',
        text: `${cap(hitscan.length)} hitscan on the enemy team and you are in the air. `
            + `Stay behind cover or switch, a flyer is a free target for ${list(hitscan)}.`,
      };
    }
  }

  // ── Diving into a brawl ────────────────────────────────────────────────
  // Straight out of ARCHETYPES: a diver reaches an isolated target, but a
  // brawl team stands close enough to punish the dive together.
  if (me.arch === 'dive') {
    const brawl = enemy.filter((e) => e.arch === 'brawl');
    if (brawl.length >= 3) {
      return {
        reason: 'dive-into-brawl',
        text: `They are grouped for a brawl, so diving in alone gets you traded. `
            + `${ARCHETYPES.dive.losesTo === 'brawl' ? 'Dive loses to brawl' : 'Dive is the wrong shape here'}, `
            + `go in with a teammate or pick something that fights at range.`,
      };
    }
  }

  // ── Poking a dive comp ─────────────────────────────────────────────────
  // The mirror of the rule above, and the reason it is worth having both: a
  // poke player standing apart is exactly what a dive comp is looking for.
  if (me.arch === 'poke') {
    const dive = enemy.filter((e) => e.arch === 'dive');
    if (dive.length >= 3) {
      return {
        reason: 'poke-into-dive',
        text: `Three divers are hunting the backline and you are playing at range. `
            + `Hold an angle near your Vanguard, ${list(dive)} will find you alone.`,
      };
    }
  }

  return null;
}

function cap(n) { return n === 2 ? 'Two' : n === 3 ? 'Three' : String(n); }

function list(hs) {
  const names = hs.map((h) => title(h.name));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function title(n) {
  return String(n).replace(/(^|[\s\-&])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

/**
 * A once-per-match gate over switchAdvice.
 *
 * Kept next to the advice rather than in the engine because "have I already
 * said this" is part of what makes the call worth listening to.
 */
function createSwitchGate() {
  const said = new Set();
  return {
    advise(p) {
      const a = switchAdvice(p);
      if (!a || said.has(a.reason)) return null;
      said.add(a.reason);
      return a;
    },
    reset() { said.clear(); },
    get saidCount() { return said.size; },
  };
}

module.exports = { switchAdvice, createSwitchGate, PATTERN, title };
