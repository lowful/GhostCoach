'use strict';

/**
 * What the Rivals coach knows about Marvel Rivals.
 *
 * The Valorant equivalent is knowledge.js, a retrieval store of pro habits. This
 * is deliberately built on a different principle, because the two games rot at
 * different speeds. Valorant map knowledge stays true for years. Rivals
 * rebalances constantly, and Season 9 alone reworked the entire team-up system.
 *
 * So knowledge here is split in two, and the split is the whole design:
 *
 *   DURABLE   how the game works. Archetypes, the counter triangle, what each
 *             role is actually for, what hitscan means. This survives patches
 *             because it describes shape rather than numbers, and it is safe to
 *             state plainly.
 *
 *   VOLATILE  which heroes are strong right now. Win rates, tier lists, "Peni
 *             is the best Vanguard". This is true for weeks, and a coach
 *             confidently naming last season's best pick is worse than a coach
 *             that says nothing about heroes at all.
 *
 * Volatile knowledge therefore carries a date and EXPIRES. Past the horizon it
 * is withheld entirely rather than hedged, on the same principle as the callout
 * gate: do not name a thing you cannot verify. The durable half keeps working
 * forever, which is why the coach is built on it and not on a tier list.
 */

// ─── Durable: how the game works ─────────────────────────────────────────────

/**
 * The three shapes a team can take, and the triangle between them.
 *
 * This is the single most useful durable fact in the game: it is transitive,
 * teachable in one sentence, and true regardless of which heroes are strong.
 */
const ARCHETYPES = {
  dive: {
    name: 'Dive',
    idea: 'get on top of the enemy backline before they can react, using mobility and off angles',
    beats: 'poke',
    losesTo: 'brawl',
    why: 'poke teams stand far apart to hold distance, so a diver reaches an isolated target, but a brawl team stands close enough to punish the diver together',
  },
  poke: {
    name: 'Poke',
    idea: 'hold distance and chip health from range, only committing once someone is already low',
    beats: 'brawl',
    losesTo: 'dive',
    why: 'a brawl team has to walk through open ground to reach you, but a dive team skips that ground entirely',
  },
  brawl: {
    name: 'Brawl',
    idea: 'stay close together and win the fight in contact, where healing and peel overlap',
    beats: 'dive',
    losesTo: 'poke',
    why: 'everyone is close enough to peel for each other, so a diver eats the whole team, but standing together is exactly what long range damage wants to see',
  },
};

/**
 * What each role is FOR, and the mistake that role makes.
 *
 * The mistakes are one idea rather than a list: nearly every role error is a
 * player importing another role's instincts. The Duelist tanking, the Vanguard
 * retreating like a support, the Strategist holding an angle like a sniper.
 * Framing it that way makes a tip land, because it names the impulse rather
 * than scolding the outcome.
 */
const ROLE_CRAFT = {
  Vanguard: {
    job: 'take and hold space, and be the reason the fight happens where you want it',
    position: 'at the edge of the point, between cover, in front of everyone',
    mistake: 'retreating like a Strategist the moment health drops, which hands over the space the team was fighting for',
    reads: 'low Damage Blocked for a Vanguard usually means space was never taken, not that the fight was unwinnable',
  },
  Duelist: {
    job: 'convert the space the Vanguard made into a pick',
    position: 'ahead of the Strategists and beside the Vanguard, not behind them. Standing directly behind the front line means every shot the team fires comes from one direction, and a single barrier stops all of it',
    mistake: 'tanking. Taking the fight at the front line without the health pool to survive it',
    reads: 'high deaths with low damage is almost always position rather than aim',
  },
  Strategist: {
    job: 'keep the team alive and decide who gets resources first',
    position: 'behind the fight with cover within one step, and never on the same sightline as the enemy backline',
    mistake: 'playing as a heal bot, or as a sniper. Staying alive and using utility on time beats raw healing done',
    reads: 'high healing on a loss often means the team was taking avoidable damage, not that healing was the problem',
  },
};

// Hitscan hits the instant you click; projectile has travel time and must be
// led. It matters for coaching because it changes what an accuracy number MEANS:
// a low percentage on a projectile hero can be correct play at range, while the
// same number on hitscan is an aim or a positioning problem.
const AIM_MODEL = {
  hitscan: 'hits instantly where the crosshair is, so accuracy reflects aim and positioning directly',
  projectile: 'has travel time and must be led, so accuracy is naturally lower at range and a low number is not automatically a mistake',
};

// ─── Volatile: who is strong right now ───────────────────────────────────────

/**
 * A dated snapshot. EVERY claim here expires.
 *
 * Kept small on purpose. A long tier list is a long list of things that will be
 * wrong in a month, and the coach is built so that losing this block entirely
 * costs it nothing structural.
 */
const META = {
  capturedAt: Date.UTC(2026, 7, 22),          // 22 August 2026
  season: 'Season 9.5',
  heroCount: 53,
  note: 'Season 9 reworked the Hero Team-Up system and moved the meta more than any patch since launch.',
  strong: ['Peni Parker', 'Rocket Raccoon', 'Loki', 'Mantis', 'Captain America', 'Groot', 'Hulk', 'Venom', 'Wolverine', 'Psylocke', 'Star-Lord', 'Adam Warlock'],
};

// Past this the snapshot is withheld rather than hedged. Matches the horizon
// rivals-meta.js already uses for hero win rates, so the two cannot disagree
// about what counts as stale.
const META_MAX_AGE_DAYS = 45;

function metaIsFresh(now = Date.now()) {
  return (now - META.capturedAt) / 86400000 <= META_MAX_AGE_DAYS;
}

// ─── Prompt blocks ───────────────────────────────────────────────────────────

/** The durable half, always safe to send. */
function fundamentals() {
  const tri = Object.values(ARCHETYPES)
    .map((a) => `- ${a.name}: ${a.idea}. Beats ${a.name === 'Dive' ? 'poke' : a.beats}, loses to ${a.losesTo}, because ${a.why}.`)
    .join('\n');

  const roles = Object.entries(ROLE_CRAFT)
    .map(([r, c]) => `- ${r}. Job: ${c.job}. Position: ${c.position}. The mistake: ${c.mistake}. Reading the numbers: ${c.reads}.`)
    .join('\n');

  return `HOW MARVEL RIVALS ACTUALLY WORKS. Ground the tip in this rather than in generic shooter advice.

THE THREE COMP SHAPES, and the triangle between them:
${tri}
Nearly every comp is one of these three, and the triangle is transitive, so
naming the shape is usually more useful than naming a hero.

WHAT EACH ROLE IS FOR:
${roles}

Nearly every role mistake is a player importing another role's instincts. Name
the impulse rather than scolding the result.

AIM MODELS: hitscan ${AIM_MODEL.hitscan}. Projectile ${AIM_MODEL.projectile}.
So an accuracy number only means something once you know which the hero is, and
if you cannot tell, do not coach the accuracy.

A standard team is two Vanguards, two Duelists and two Strategists. Deviating is
not automatically wrong, but a role at zero is: no Strategist means nothing gets
healed, and no Vanguard means whoever is picked first decides the fight.`;
}

/** The volatile half, only while it is still true. */
function metaBlock(now = Date.now()) {
  if (!metaIsFresh(now)) return '';
  return `CURRENT META, captured ${new Date(META.capturedAt).toISOString().slice(0, 10)} for ${META.season} across ${META.heroCount} heroes. ${META.note}
Heroes performing strongly right now: ${META.strong.join(', ')}.
Treat this as background only. NEVER tell the player to switch to a hero on this
list purely because it is on this list, and never claim a hero is weak. The
player's own results with a hero outrank any tier list.`;
}

/**
 * Everything the prompt should carry.
 *
 * @param opts.meta include the dated snapshot (default true)
 */
function block(opts = {}) {
  const parts = [fundamentals()];
  if (opts.meta !== false) {
    const m = metaBlock(opts.now);
    if (m) parts.push(m);
  }
  return parts.join('\n\n');
}

module.exports = {
  ARCHETYPES, ROLE_CRAFT, AIM_MODEL, META, META_MAX_AGE_DAYS,
  metaIsFresh, fundamentals, metaBlock, block,
};
