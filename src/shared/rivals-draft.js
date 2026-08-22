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
 * The game prints SUGGESTED PICK: <ROLE> bottom right, which looked at first
 * like the Rivals equivalent of Valorant printing a location name on the HUD.
 * It is not, and the frames are why. Two separate things had to be told apart:
 *
 *   how RELIABLY a thing is READ. The banner was read correctly on all four
 *   frames. The roster was read wrong on all four, twice reporting nobody at
 *   all when the bottom row plainly showed three and five teammates.
 *
 *   whether the thing is CURRENT. The banner read VANGUARD from 22s down to 2s
 *   while the slots filled up, and that match ended 2-2-2 with the player on a
 *   Duelist, so it was probably stale advice read perfectly.
 *
 * A perfectly read stale answer and a badly read live one are both wrong, so
 * nothing here trusts one witness alone. The roster decides when it is
 * trustworthy, the banner stands in when it is not, and the countdown is a third
 * witness used to catch the roster lying: teammates lock in as the clock runs
 * down, so an empty team late in the draft cannot be true.
 *
 * Nothing here talks to the network or the Rivals API. It is arithmetic over a
 * roster plus one printed string, which is exactly why it can be finished and
 * tested while the API is down.
 */
const { ROLES, TEAM_SIZE, IDEAL, normaliseRole, countRoles, pickHelps } = require('./rivals-comp');

// Seconds left below which an EMPTY roster is a misread rather than a fact.
// Hero select counts down from roughly thirty seconds while teammates lock in,
// so ten is late enough that a team of nobody cannot be true, and early enough
// that a genuinely slow lobby is not silenced.
const EMPTY_ROSTER_DEADLINE = 10;

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

  // THE CLOCK CONTRADICTS THE ROSTER, so neither can be trusted.
  //
  // An empty roster is not "unknown", it is a confident claim that nobody has
  // locked in, and it sails through the check above. Measured on four real
  // draft frames the roster read was wrong on all four, twice reporting nobody
  // at all when the bottom row plainly showed three and five teammates.
  //
  // The countdown is the second witness, and it reads reliably: 22, 18, 8 and 2
  // were all correct. Hero select runs down from about thirty seconds while
  // players lock in, so an empty team late in the draft is arithmetic that
  // cannot be true. Refusing here costs one tip; believing it advises the
  // opposite role at the moment the player can least afford it.
  const timer = Number(d.timer);
  if (Number.isFinite(timer) && timer <= EMPTY_ROSTER_DEADLINE && locked.length === 0) return null;

  // More locked teammates than seats means the read is wrong, not that the game
  // has changed. Refuse rather than reason from it.
  if (locked.length >= size) return null;

  const printed = readSuggested(d.suggested);

  // What the arithmetic says: fill an empty role first, then a role that is
  // still under its share.
  const empty = ROLES.filter((r) => counts[r] === 0);
  const under = ROLES.filter((r) => counts[r] < IDEAL[r]);
  const computed = empty[0] || under[0] || null;

  // THE ROSTER WINS, and this was the other way round until the capture frames
  // argued against it.
  //
  // The banner is a printed fact, which is why it looked like the better
  // witness. What it is NOT is provably current. Across four frames of one real
  // draft, at 22s, 18s, 8s and 2s, it read VANGUARD the whole way down while the
  // team slots visibly filled up, and that match's scoreboard shows the player
  // finishing on a 2-2-2 as a Duelist. If their five teammates were already
  // 2V/1D/2S, the role actually missing was Duelist, and following the banner
  // would have talked them out of the right pick with two seconds left.
  //
  // So the readable roster decides, because it describes the draft as it stands
  // now. The banner is corroboration when they agree and a fallback when the
  // roster cannot be read, which is the case it is genuinely better at.
  const role = computed || printed;
  if (!role) return null;

  // Never recommend a pick that makes the comp worse. pickHelps returns null
  // when the roster cannot be trusted, and null is not permission.
  if (pickHelps(locked, role) !== true) return null;

  return {
    role,
    // Both witnesses said the same thing, which is the confident case and worth
    // saying out loud in the tip.
    agreed: !!(printed && computed && printed === computed),
    source: computed ? 'comp' : 'game',
    // What the game said, kept even when it lost, so the interface can show a
    // disagreement rather than quietly discarding one of the two readings.
    printed: printed || null,
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
