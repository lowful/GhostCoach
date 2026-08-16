'use strict';

/**
 * How good is a hero, and how good is it FOR THIS PLAYER.
 *
 * Two different questions, and the second one is the reason this file exists.
 * A tier list is public information that any website gives away; the coach's
 * value is knowing that the player averages 0.7 K/D on the S-tier pick and 1.4
 * on the B-tier one. Reading a tier list back at someone is not coaching.
 *
 * THE GOVERNING RULE: the player's own record usually outweighs the meta. A
 * strong hero played badly loses to a mediocre hero played well, and telling
 * someone to pick the season's best character when they cannot play it is how a
 * coach gets ignored. Meta strength breaks the tie when the player has no
 * record either way, and it earns a mention when the gap is genuinely large.
 *
 * META DATA HAS A SHELF LIFE, which is the other half of this file. Marvel Rivals
 * patches frequently: Season 9.5 landed on 7 August 2026, nerfed the highest
 * win rate hero in the game, buffed several underdogs and added a new Vanguard.
 * Tier data from before a patch is not merely old, it is confidently wrong, and
 * a coach citing it sounds authoritative while being out of date. So every
 * reading carries the patch it came from and goes quiet once it is stale, the
 * same way the Valorant coach refuses a callout it cannot verify.
 *
 * Public sources also disagree with each other. Two tier lists on the same day
 * put the same hero at 59.1% and 56.3%. That spread is wide enough that precise
 * numbers should never be quoted to a player; the BAND is the honest unit.
 */

// How long a meta reading stays usable. A patch invalidates tier data
// immediately, and Rivals ships balance changes roughly monthly, so anything
// older than this is treated as unknown rather than as fact.
const META_MAX_AGE_DAYS = 45;

// Win-rate bands rather than exact figures, because sources disagree by three
// points on the same hero on the same day. A band survives that disagreement;
// a decimal does not.
const BANDS = [
  { min: 55.0, tier: 'S', label: 'one of the strongest picks this patch' },
  { min: 52.5, tier: 'A', label: 'a strong pick this patch' },
  { min: 49.0, tier: 'B', label: 'a fair pick this patch' },
  { min: 46.0, tier: 'C', label: 'below the curve this patch' },
  { min: 0,    tier: 'D', label: 'struggling this patch' },
];

function bandFor(winRate) {
  const w = Number(winRate);
  if (!isFinite(w) || w <= 0) return null;
  return BANDS.find((b) => w >= b.min) || BANDS[BANDS.length - 1];
}

/**
 * Is this meta snapshot still worth quoting?
 * @param meta { patch, fetchedAt } as produced by the sync
 */
function metaIsFresh(meta, now = Date.now()) {
  if (!meta || !meta.fetchedAt) return false;
  const ageDays = (now - meta.fetchedAt) / 86400000;
  return ageDays <= META_MAX_AGE_DAYS;
}

/**
 * The player's own record on a hero, reduced to a verdict.
 *
 * Needs enough games to mean anything. One good game is not a strength and one
 * bad game is not a weakness, and treating either as evidence is how a coach
 * ends up telling someone they are bad at a hero they have played twice.
 */
const MIN_GAMES = 4;

function playerForm(record) {
  if (!record || (record.matches || 0) < MIN_GAMES) return null;
  const kd = Number(record.kd);
  const wr = Number(record.winRate);
  if (!isFinite(kd)) return null;
  if (kd >= 1.25 || wr >= 60) return { level: 'strong', kd, wr, matches: record.matches };
  if (kd <= 0.85 || (isFinite(wr) && wr <= 42)) return { level: 'weak', kd, wr, matches: record.matches };
  return { level: 'even', kd, wr, matches: record.matches };
}

/**
 * Should this player pick this hero?
 *
 * @param hero     { name, role }
 * @param meta     { patch, fetchedAt, heroes: { [name]: { winRate } } }
 * @param record   this player's own record on the hero, from the tracker
 * @returns { verdict, reason, tier|null, form|null } or null when there is
 *          nothing honest to say
 *
 * Returns null freely. Silence is a valid answer here: with no player record
 * and no fresh meta there is genuinely nothing to add beyond what the player
 * can already see on their own screen.
 */
function heroAdvice(hero, meta, record) {
  const name = hero && hero.name;
  if (!name) return null;

  const fresh = metaIsFresh(meta);
  const wr = fresh && meta.heroes ? (meta.heroes[name] || {}).winRate : null;
  const tier = fresh ? bandFor(wr) : null;
  const form = playerForm(record);

  // Nothing known about the hero and nothing known about the player.
  if (!tier && !form) return null;

  // THE PLAYER'S RECORD LEADS. A hero they are demonstrably good at is the
  // right pick even when the tier list disagrees, and saying otherwise is how
  // a coach talks someone out of their best character.
  if (form && form.level === 'strong') {
    return {
      verdict: 'pick',
      tier: tier ? tier.tier : null,
      form,
      reason: tier && tier.tier === 'D'
        ? `You play ${name} well, so keep picking it even though it is ${tier.label}.`
        : `${name} is one of your best, so this is a comfortable pick.`,
    };
  }

  if (form && form.level === 'weak') {
    return {
      verdict: 'avoid',
      tier: tier ? tier.tier : null,
      form,
      reason: tier && (tier.tier === 'S' || tier.tier === 'A')
        // The case that most needs saying out loud, because the tier list is
        // actively pulling the player toward a hero they cannot use.
        ? `${name} is ${tier.label}, but your record on it is not, so it is not a free win for you yet.`
        : `Your record on ${name} is behind the rest of your heroes.`,
    };
  }

  // No usable record: fall back to the meta, which is what it is actually for.
  if (tier) {
    return {
      verdict: tier.tier === 'S' || tier.tier === 'A' ? 'pick' : tier.tier === 'D' ? 'avoid' : 'neutral',
      tier: tier.tier,
      form,
      reason: `${name} is ${tier.label}.`
        + (form ? '' : ' You have not played it enough for your own record to say much.'),
    };
  }

  return {
    verdict: 'neutral', tier: null, form,
    reason: `Your record on ${name} is around your average.`,
  };
}

module.exports = {
  META_MAX_AGE_DAYS, MIN_GAMES, BANDS,
  bandFor, metaIsFresh, playerForm, heroAdvice,
};
