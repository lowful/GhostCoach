'use strict';

/**
 * Team composition arithmetic for Marvel Rivals.
 *
 * This is the brain of draft coaching, and it is deliberately pure: it takes
 * role counts and returns a verdict. No API, no hero data, no screenshot. That
 * matters because the model will be asked to READ a hero select screen and then
 * REASON about it, and the reasoning half must not be left to the model. It
 * cannot count reliably, and a confident "you need another Vanguard" said to a
 * team that already has three is exactly the sort of plausible wrongness this
 * project has spent its life removing from the Valorant coach.
 *
 * The shape of the advice comes from what actually wins: 2-2-2, two Vanguards,
 * two Duelists, two Strategists, holds roughly a 54% win rate and about a 63%
 * play rate, ahead of every alternative. Each role covers a failure mode of the
 * others, which is why the balanced split beats stacking:
 *
 *   too few Vanguards    no front line, the team collapses when one is focused
 *   too few Strategists  nothing survives, healing cannot cover the roster
 *   too few Duelists     nothing dies, the team cannot close a fight
 *
 * A team is exactly SIX players. That invariant is enforced rather than assumed,
 * the same way Valorant's round = your score + their score + 1 is enforced,
 * because a miscounted roster silently invalidates every conclusion drawn from
 * it.
 */

const ROLES = ['Vanguard', 'Duelist', 'Strategist'];
const TEAM_SIZE = 6;

// The meta split, and the floors below which a comp is actively broken rather
// than merely unusual.
const IDEAL = { Vanguard: 2, Duelist: 2, Strategist: 2 };
const MIN = { Vanguard: 1, Duelist: 1, Strategist: 1 };

/** Normalise a role name from anything the model might write. */
function normaliseRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r.startsWith('van') || r === 'tank') return 'Vanguard';
  if (r.startsWith('duel') || r === 'dps' || r === 'damage') return 'Duelist';
  if (r.startsWith('strat') || r === 'support' || r === 'healer') return 'Strategist';
  return null;
}

/**
 * Count roles on a team.
 * @param roles an array of role names, one per player, in any spelling
 * @returns { counts, total, unknown } where unknown is how many were unreadable
 */
function countRoles(roles) {
  const counts = { Vanguard: 0, Duelist: 0, Strategist: 0 };
  let unknown = 0;
  for (const r of (Array.isArray(roles) ? roles : [])) {
    const n = normaliseRole(r);
    if (n) counts[n]++;
    else unknown++;
  }
  return { counts, total: counts.Vanguard + counts.Duelist + counts.Strategist, unknown };
}

/**
 * Judge a composition.
 *
 * Returns null when the roster cannot be trusted, which is the important half.
 * A draft read from a screenshot will sometimes be short a player or carry an
 * unreadable role, and advising on a miscounted team is worse than staying
 * quiet: the advice will be specific, confident, and about a team that does not
 * exist. Valorant's guards learned this the expensive way.
 *
 * @returns { ok, counts, missing, excess, verdict, advice } | null
 */
function analyseComp(roles) {
  const { counts, total, unknown } = countRoles(roles);

  // Refuse to judge an incomplete or partly unreadable roster.
  if (unknown > 0 || total !== TEAM_SIZE) return null;

  const missing = ROLES.filter((r) => counts[r] < MIN[r]);
  const excess = ROLES.filter((r) => counts[r] > IDEAL[r] + 1);   // 4+ of one role
  const isIdeal = ROLES.every((r) => counts[r] === IDEAL[r]);

  let verdict, advice;
  if (missing.length) {
    // A zero in any role is the one genuinely broken case, so it outranks
    // everything else regardless of how the rest is arranged.
    verdict = 'broken';
    const m = missing[0];
    advice = m === 'Strategist'
      ? 'No Strategist means nothing on this team gets healed, which loses fights the team is otherwise winning. Someone has to switch.'
      : m === 'Vanguard'
        ? 'No Vanguard means no front line, so the first pick decides every fight. Someone has to switch.'
        : 'No Duelist means the team can survive a fight it cannot win. Someone needs damage.';
  } else if (isIdeal) {
    verdict = 'ideal';
    advice = 'The comp is a standard 2-2-2, so play the matchup rather than the draft.';
  } else if (excess.length) {
    verdict = 'stacked';
    const x = excess[0];
    const short = ROLES.filter((r) => counts[r] < IDEAL[r])[0];
    advice = `${counts[x]} ${x}s is more than the comp can use`
      + (short ? `, and it leaves you short a ${short}.` : '.');
  } else {
    verdict = 'workable';
    advice = 'Not a standard 2-2-2, but every role is covered, so this is playable.';
  }

  return {
    ok: verdict !== 'broken',
    counts,
    missing,
    excess,
    verdict,               // 'ideal' | 'workable' | 'stacked' | 'broken'
    advice,
  };
}

/**
 * Does a proposed pick improve the comp?
 *
 * Used to sanity-check the model's recommendation before it reaches the player:
 * suggesting a fourth Duelist to a team already stacked on Duelists is the hero
 * shooter equivalent of naming a callout from the wrong map.
 *
 * @param currentRoles roles already locked, excluding the player
 * @param pickRole the role being recommended
 */
function pickHelps(currentRoles, pickRole) {
  const role = normaliseRole(pickRole);
  if (!role) return null;                       // unreadable, no opinion
  const { counts, unknown } = countRoles(currentRoles);
  if (unknown > 0) return null;                 // roster not trustworthy
  // Filling an empty role always helps, and nothing else is more urgent.
  if (counts[role] === 0) return true;
  // Otherwise it helps only while it does not push the role past the ideal.
  return counts[role] < IDEAL[role];
}

module.exports = { ROLES, TEAM_SIZE, IDEAL, MIN, normaliseRole, countRoles, analyseComp, pickHelps };

/**
 * The role a scoreboard row PROVES, from its numbers rather than its icon.
 *
 * The model reads small role icons badly. On a real scoreboard it called a
 * Duelist a Vanguard, and the review tip then framed the whole thing around
 * damage blocked and holding space, which is Vanguard advice given to somebody
 * playing damage.
 *
 * The columns settle it, but only partly, and the partly is the point:
 *
 *   HEALING separates Strategists absolutely. Measured across twelve real rows,
 *   Strategists healed 13,068 to 33,213 and everybody else 0 to 567. A 24x gap
 *   is not a threshold that needs tuning.
 *
 *   DAMAGE BLOCKED does NOT separate Vanguard from Duelist. Those same rows
 *   overlap: the lowest Vanguard blocked 8,431 and the highest Duelist 12,283.
 *   Any rule drawn through that is a coin flip wearing a number.
 *
 * So this returns 'Strategist' or null, and null means "the numbers do not say",
 * which is different from the model's guess being right. Callers must treat null
 * as unverified rather than as a Duelist.
 */
const HEALING_PROVES_STRATEGIST = 2000;   // an order of magnitude clear of both groups

function roleFromStats(row) {
  const r = row || {};
  const healing = Number(r.healing);
  if (!Number.isFinite(healing)) return null;
  return healing >= HEALING_PROVES_STRATEGIST ? 'Strategist' : null;
}

/**
 * Reconcile the model's role read against what the numbers prove.
 *
 * @returns { role, verified, corrected } where role is null when nothing is
 *          certain, so a caller can decline to give role-shaped advice at all.
 */
function verifyRole(claimed, row) {
  const said = normaliseRole(claimed);
  const proven = roleFromStats(row);

  // The numbers prove Strategist. Code wins, as everywhere else in this app.
  if (proven === 'Strategist') {
    return { role: 'Strategist', verified: true, corrected: said !== 'Strategist' };
  }
  // The numbers prove NOT a Strategist, so a claim of Strategist is refuted even
  // though they cannot say which of the other two it is.
  if (roleFromStats(row) === null && Number.isFinite(Number((row || {}).healing)) && said === 'Strategist') {
    return { role: null, verified: false, corrected: true };
  }
  // Vanguard versus Duelist is unverifiable from the columns, so the claim is
  // passed through UNVERIFIED rather than endorsed.
  return { role: said, verified: false, corrected: false };
}

module.exports.roleFromStats = roleFromStats;
module.exports.verifyRole = verifyRole;
module.exports.HEALING_PROVES_STRATEGIST = HEALING_PROVES_STRATEGIST;
