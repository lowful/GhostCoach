'use strict';

/**
 * Marvel Rivals hero traits, hand authored.
 *
 * WHY THIS IS NOT FETCHED. There is no official Marvel Rivals developer API.
 * Every tracker derives its data by scraping, community submission, or network
 * monitoring, and that last one is a thing this product can never do. The one
 * usable community dataset (Causalzap/rivalsvictory-assets) carries 40 heroes
 * against the 53 this app's own META block knows for Season 9.5, has no licence
 * at all, and classifies nothing about aim or mobility. It would be a
 * downgrade. marvelrivalsapi.com has been 502 for the whole of this work.
 *
 * So the traits live here, and the important part is what happens when a hero
 * is missing.
 *
 * ABSENCE MEANS SILENCE, NEVER A GUESS. A hero not in this table produces no
 * counter advice at all. Telling a player to switch off a flyer who is not
 * flying is worse than saying nothing, and the roster grows by roughly a hero
 * a season, so the table is always going to be behind at some point. That is
 * fine as long as being behind costs coverage rather than correctness. This is
 * the same rule the Valorant side follows: the coach reports what it can
 * verify and never infers.
 *
 * Fields:
 *   role   Vanguard | Duelist | Strategist, as the game names them
 *   aim    hitscan | projectile | melee, what the primary fire actually is
 *   air    flight | leap | ground, sustained flight vs a jump vs neither
 *   arch   dive | poke | brawl, which of the three archetypes it plays into
 *
 * Deliberately PARTIAL. Every entry here is one I am confident about; heroes I
 * am unsure of are omitted rather than guessed, which is exactly what the
 * fail-safe above is for. Extending it is a data task, and
 * `npm run test:rivalsheroes` asserts the shape of anything added.
 */

const HEROES = {
  // ── Vanguards ────────────────────────────────────────────────────────────
  'hulk':             { role: 'Vanguard',   aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'doctor strange':   { role: 'Vanguard',   aim: 'projectile', air: 'flight', arch: 'brawl' },
  'groot':            { role: 'Vanguard',   aim: 'projectile', air: 'ground', arch: 'brawl' },
  'magneto':          { role: 'Vanguard',   aim: 'projectile', air: 'ground', arch: 'poke'  },
  'peni parker':      { role: 'Vanguard',   aim: 'projectile', air: 'ground', arch: 'brawl' },
  'venom':            { role: 'Vanguard',   aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'thor':             { role: 'Vanguard',   aim: 'melee',      air: 'leap',   arch: 'brawl' },
  'captain america':  { role: 'Vanguard',   aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'the thing':        { role: 'Vanguard',   aim: 'melee',      air: 'ground', arch: 'brawl' },
  'emma frost':       { role: 'Vanguard',   aim: 'projectile', air: 'ground', arch: 'brawl' },

  // ── Duelists ─────────────────────────────────────────────────────────────
  'iron man':         { role: 'Duelist',    aim: 'projectile', air: 'flight', arch: 'poke'  },
  'storm':            { role: 'Duelist',    aim: 'projectile', air: 'flight', arch: 'poke'  },
  'human torch':      { role: 'Duelist',    aim: 'projectile', air: 'flight', arch: 'poke'  },
  'the punisher':     { role: 'Duelist',    aim: 'hitscan',    air: 'ground', arch: 'poke'  },
  'black widow':      { role: 'Duelist',    aim: 'hitscan',    air: 'ground', arch: 'poke'  },
  'hela':             { role: 'Duelist',    aim: 'hitscan',    air: 'ground', arch: 'poke'  },
  'star-lord':        { role: 'Duelist',    aim: 'hitscan',    air: 'leap',   arch: 'dive'  },
  'hawkeye':          { role: 'Duelist',    aim: 'projectile', air: 'ground', arch: 'poke'  },
  'squirrel girl':    { role: 'Duelist',    aim: 'projectile', air: 'ground', arch: 'poke'  },
  'moon knight':      { role: 'Duelist',    aim: 'projectile', air: 'ground', arch: 'poke'  },
  'scarlet witch':    { role: 'Duelist',    aim: 'projectile', air: 'flight', arch: 'brawl' },
  'winter soldier':   { role: 'Duelist',    aim: 'projectile', air: 'ground', arch: 'brawl' },
  'namor':            { role: 'Duelist',    aim: 'projectile', air: 'ground', arch: 'poke'  },
  'spider-man':       { role: 'Duelist',    aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'black panther':    { role: 'Duelist',    aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'magik':            { role: 'Duelist',    aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'wolverine':        { role: 'Duelist',    aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'iron fist':        { role: 'Duelist',    aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'psylocke':         { role: 'Duelist',    aim: 'melee',      air: 'leap',   arch: 'dive'  },
  'mister fantastic': { role: 'Duelist',    aim: 'melee',      air: 'ground', arch: 'brawl' },
  'phoenix':          { role: 'Duelist',    aim: 'projectile', air: 'flight', arch: 'poke'  },

  // ── Strategists ──────────────────────────────────────────────────────────
  'luna snow':        { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'brawl' },
  'mantis':           { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'poke'  },
  'rocket raccoon':   { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'brawl' },
  'jeff the land shark': { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'brawl' },
  'cloak & dagger':   { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'brawl' },
  'adam warlock':     { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'poke'  },
  'loki':             { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'poke'  },
  'invisible woman':  { role: 'Strategist', aim: 'projectile', air: 'ground', arch: 'poke'  },
  'ultron':           { role: 'Strategist', aim: 'projectile', air: 'flight', arch: 'poke'  },
};

/** Spellings the kill feed and scoreboard actually use. */
const ALIASES = {
  'punisher': 'the punisher',
  'jeff': 'jeff the land shark',
  'cloak and dagger': 'cloak & dagger',
  'dr strange': 'doctor strange',
  'strange': 'doctor strange',
  'bucky': 'winter soldier',
  'starlord': 'star-lord',
  'star lord': 'star-lord',
  'spiderman': 'spider-man',
  'rocket': 'rocket raccoon',
  'cap': 'captain america',
};

function normalise(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Traits for a hero, or null when it is not one we can vouch for. */
function traits(name) {
  const n = normalise(name);
  if (!n) return null;
  const key = ALIASES[n] || n;
  const h = HEROES[key];
  return h ? Object.assign({ name: key }, h) : null;
}

function known(name) { return traits(name) !== null; }

// Named constants rather than inline literals, because these two have already
// been destroyed twice by being written through a shell heredoc, where \r?\n
// collapses into a real newline and the file stops parsing. Keeping them here
// means there is one place to check.
const RE_LINES = /\r?\n/;
const RE_HERO = /^\s*HERO:\s*([^|]+)\|\s*(mine|ally|enemy|unknown)\s*$/i;

/**
 * Parse the /identify reply into a roster.
 *
 * Lives here rather than in the route so it can be tested with no environment,
 * and because dropping a malformed line is a hero-knowledge decision: a line
 * that does not parse is a hero we cannot vouch for, which is the same rule
 * traits() follows.
 */
function parseRoster(raw) {
  const out = [];
  for (const line of String(raw || '').split(RE_LINES)) {
    const m = line.match(RE_HERO);
    if (!m) continue;
    const name = m[1].trim();
    if (name) out.push({ name, side: m[2].toLowerCase() });
  }
  return out;
}

module.exports = { HEROES, ALIASES, traits, known, normalise, parseRoster };
