'use strict';

/**
 * What to tell a player at hero select.
 *
 * Written against real capture frames, and the first thing those frames settled
 * is that the plan for this feature was wrong.
 *
 * THE ENEMY TEAM IS NOT ON SCREEN AT HERO SELECT. The written plan's flagship
 * example was "they have three dive heroes and no shield, take Namor or Peni",
 * and nothing like it is possible: the draft screen shows the hero picker, your
 * own team's slots, the map and the timer. There is no enemy roster anywhere.
 * Counter picking therefore cannot happen at draft, and belongs to the mid match
 * switch call, where the enemy team is finally visible on the scoreboard.
 *
 * What IS on screen turns out to be better than a workaround. The game prints
 *
 *     SUGGESTED PICK: VANGUARD
 *
 * in the bottom right. That is a role recommendation from the game itself, and
 * it is the Rivals equivalent of Valorant printing the location name on the HUD:
 * a deterministic fact the model can read but must not invent. So it is treated
 * the same way the location labels are, as the more reliable witness, and the
 * model's own read of the team has to agree with it or the tip is dropped.
 *
 * Nothing here talks to the network or the Rivals API. It is arithmetic over a
 * roster plus one printed string, which is exactly why it can be finished and
 * tested while the API is down.
 */
const { ROLES, TEAM_SIZE, IDEAL, normaliseRole, countRoles, pickHelps } = require('./rivals-comp');

/** Pull the role out of whatever the model reports for the printed banner. */
const ROLE_WORD = /\b(vanguard|duelist|strategist|dps|tank|support|healer|damage)\b/i;
// Anchored on "suggest", then skipping an optional "pick", punctuation and an
// article, to land on a ROLE WORD rather than on whatever word comes next.
// Capturing the next word reads "the game suggests a Strategist" as the article,
// and a stray lowercase "a" has already broken three rules in this codebase.
const SUGGESTED_ROLE = /suggest\w*[\s:.\-]*(?:pick)?[\s:.\-]*(?:a |an |the )?(vanguard|duelist|strategist|dps|tank|support|healer|damage)\b/i;

function readSuggested(text) {
  const t = String(text || '');
  const m = SUGGESTED_ROLE.exec(t) || ROLE_WORD.exec(t);
  return m ? normaliseRole(m[1]) : null;
}

/**
 * The role the player should take.
 *
 * @param draft {
 *   locked:    roles already taken by teammates, EXCLUDING the player
 *   suggested: whatever the model read off the SUGGESTED PICK banner
 *   teamSize:  how many players a team has, defaults to 6
 * }
 * @returns { role, why, agreed, source } or null when there is nothing to say
 */
function draftAdvice(draft) {
  // No draft object means the frame was never read, which is a different thing
  // from reading it and finding nobody has locked in yet. The first has to stay
  // silent; the second is a real state worth advising on.
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.locked)) return null;
  const d = draft;
  const size = Number.isFinite(d.teamSize) ? d.teamSize : TEAM_SIZE;
  const locked = d.locked;

  // An unreadable roster gets no advice at all. A half read draft produces
  // confident advice about a team that does not exist, which is the failure the
  // Valorant map lock exists to prevent, arriving in a new game.
  const { counts, unknown } = countRoles(locked);
  if (unknown > 0) return null;

  // More locked teammates than seats means the read is wrong, not that the game
  // has changed. Refuse rather than reason from it.
  if (locked.length >= size) return null;

  const printed = readSuggested(d.suggested);

  // What the arithmetic says: fill an empty role first, then a role that is
  // still under its share.
  const empty = ROLES.filter((r) => counts[r] === 0);
  const under = ROLES.filter((r) => counts[r] < IDEAL[r]);
  const computed = empty[0] || under[0] || null;

  // THE GAME WINS. When the banner was readable it decides the role, because it
  // is a printed fact and the model's role tally is a reading of six small
  // portraits. The computed answer is kept only to say whether they agreed,
  // which is what lets the interface admit uncertainty instead of asserting.
  const role = printed || computed;
  if (!role) return null;

  // Never recommend a pick that makes the comp worse. pickHelps returns null
  // when the roster cannot be trusted, and null is not permission.
  if (pickHelps(locked, role) !== true) return null;

  const agreed = !!(printed && computed && printed === computed);
  return {
    role,
    agreed,
    source: printed ? 'game' : 'comp',
    why: reasonFor(role, counts, empty.includes(role)),
  };
}

/** One sentence saying why, in terms of what is actually missing. */
function reasonFor(role, counts, isEmpty) {
  if (isEmpty) {
    if (role === 'Strategist') return 'nobody is healing, and fights you are winning will turn without it';
    if (role === 'Vanguard') return 'there is no front line, so whoever gets picked first decides the fight';
    return 'the team has no damage, so it can survive a fight without ever closing it';
  }
  return `the team is short a ${role}, ${counts[role]} of the usual ${IDEAL[role]}`;
}

/**
 * Is a tip about the draft allowed out?
 *
 * The Rivals counterpart of the callout gate. A draft tip that names the enemy
 * team is describing something that was never on screen, so it is refused
 * outright rather than trusted, however plausible it sounds.
 */
const ENEMY_CLAIM = /\b(they|their|enemy|enemies|opponents?|other team)\b[^.]{0,40}\b(have|has|picked|running|comp|stacked|team)\b|\benemy (comp|team|roster|lineup)\b|\bthey are running\b/i;

function draftTipAllowed(text, draft) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: 'empty' };

  // The enemy roster is not visible at hero select, so any claim about it is
  // invented no matter how confident it reads.
  if (ENEMY_CLAIM.test(t)) return { ok: false, why: 'claims something about the enemy team, which is not on screen at draft' };

  const advice = draftAdvice(draft);
  if (!advice) return { ok: false, why: 'the draft could not be read well enough to advise' };

  // If the tip names a role, it has to be the role the draft actually calls for.
  const named = ROLES.filter((r) => new RegExp(`\\b${r}s?\\b`, 'i').test(t));
  if (named.length && !named.includes(advice.role)) {
    return { ok: false, why: `recommends ${named[0]} when the draft needs ${advice.role}` };
  }
  return { ok: true, advice };
}

module.exports = { draftAdvice, draftTipAllowed, readSuggested, ENEMY_CLAIM };
