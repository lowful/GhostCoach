'use strict';

/**
 * League champions, read from the generated Data Dragon file.
 *
 * IN src/shared/ AND NOT IN server/, because only server/ deploys to Railway
 * and check:server enforces that it never reaches outside itself. Nothing on
 * the backend reads champions: the learning surface is assembled in the main
 * process from data that ships with the app, which is why it works offline.
 *
 * The shape of rivals-heroes.js, but with far less hand authoring, and the
 * difference is the whole point of picking League: Riot publishes the roster,
 * the roles, a difficulty score and the attack range, so role, difficulty and
 * melee-versus-ranged are all DERIVED. The Rivals table had to invent every one
 * of those by hand and could only vouch for 40 of 53 heroes.
 *
 * The same silence rule still applies, because it is about honesty rather than
 * about the data source: an unknown champion returns null and nothing
 * downstream says anything about it.
 *
 * WHAT RIOT DOES NOT PUBLISH is lane. `tags` says Mage or Fighter, not mid or
 * top, and a champion's lane moves with the meta anyway. So there is no lane
 * table for all 173, because that would be 173 guesses maintained by nobody.
 * What there IS instead is a small curated STARTERS list: the champions worth
 * learning first in each role, which is the only lane question a beginner
 * actually has, and it is short enough to be kept true.
 */

const data = require('./lol-data.generated.json');

const BY_ID = new Map();
const BY_NAME = new Map();
for (const c of data.champions) {
  BY_ID.set(c.id.toLowerCase(), c);
  BY_NAME.set(c.name.toLowerCase(), c);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/** A champion by Data Dragon id or display name, or null. */
function champion(nameOrId) {
  const raw = String(nameOrId || '').toLowerCase().trim();
  if (!raw) return null;
  return BY_ID.get(raw) || BY_NAME.get(raw)
    // Last resort: strip punctuation, so "Kai'Sa", "KaiSa" and "kai sa" agree.
    || data.champions.find((c) => norm(c.id) === norm(raw) || norm(c.name) === norm(raw))
    || null;
}

function all() { return data.champions; }
function count() { return data.count; }
function patch() { return data.patch; }

/** Champions carrying a given Riot tag: Mage, Fighter, Assassin, Marksman, Tank, Support. */
function byRole(tag) {
  const t = String(tag || '').toLowerCase();
  return data.champions.filter((c) => c.tags.some((x) => x.toLowerCase() === t));
}

/**
 * The champions Riot itself scores as simple.
 *
 * Uses Riot's own difficulty rather than an opinion, which means it stays true
 * across reworks without anyone maintaining it.
 */
function beginnerFriendly(role) {
  const pool = role ? byRole(role) : data.champions;
  return pool.filter((c) => c.difficultyBand === 'low')
    .sort((a, b) => a.difficulty - b.difficulty || a.name.localeCompare(b.name));
}

/**
 * Where to start, per role.
 *
 * CURATED, and deliberately short. Riot's difficulty score says how hard a
 * champion is to execute, not how much a beginner LEARNS from playing it, and
 * those differ: a champion can be mechanically simple and still teach nothing
 * about spacing. Each entry says why, because "play Garen" without a reason is
 * advice a player cannot check or disagree with.
 *
 * Ids are validated against the generated roster by test:lolchampions, so a
 * rename or a removal breaks the build rather than silently pointing at
 * nothing.
 */
const STARTERS = {
  Top: [
    { id: 'Garen', why: 'No resource to manage, so every mistake is a positioning mistake you can see' },
    { id: 'Malphite', why: 'Teaches you to look for the one fight-winning ultimate instead of forcing plays' },
  ],
  Jungle: [
    { id: 'Warwick', why: 'Sustains through a clear, so you learn pathing before you learn survival' },
    { id: 'Amumu', why: 'One clear engage tool, which makes gank timing the only thing to think about' },
  ],
  Mid: [
    { id: 'Annie', why: 'Point-and-click damage, so laning is about wave state rather than aim' },
    { id: 'Lux', why: 'Long range punishes bad enemy positioning and teaches you to spot it' },
  ],
  Bot: [
    { id: 'Ashe', why: 'Slows on every attack, which forgives the kiting a new marksman gets wrong' },
    { id: 'MissFortune', why: 'Straightforward trades that teach last hitting under pressure' },
  ],
  Support: [
    { id: 'Soraka', why: 'Healing makes the cost of a bad position obvious and immediate' },
    { id: 'Leona', why: 'Engages are binary, so you learn to pick the moment rather than the button' },
  ],
};

const LANES = Object.keys(STARTERS);

module.exports = { champion, all, count, patch, byRole, beginnerFriendly, STARTERS, LANES };
