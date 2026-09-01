'use strict';

/**
 * WHEN a live Rivals tip is allowed to appear.
 *
 * Valorant tips ride a timer because a Valorant round has long stretches where
 * a player is walking and can read. A 6v6 hero shooter has almost none: the
 * fight is continuous, and a tip that lands mid-fight is either ignored or it
 * gets someone killed.
 *
 * So Rivals does not stream tips at all. It waits for one of a small number of
 * MOMENTS, each chosen because the player is provably not shooting and the
 * screen is showing something unambiguous:
 *
 *   death        respawn timer is up, they are watching a killcam, and they are
 *                about to choose whether to switch. This is the single most
 *                valuable moment in the game to say anything at all.
 *   teamWipe     nobody is contesting, everyone is walking back in
 *   objective    a point flipped, the pace resets for a few seconds
 *   roundStart   staging before contact
 *
 * This is the same rule that governs the Valorant death review, arrived at from
 * the other direction: there, silence had to be ADDED after a death. Here,
 * speech has to be EARNED.
 *
 * Pure and DOM free so the whole gate is testable offline.
 */

/** The moments a tip may ride, and how long the window stays open. */
const MOMENTS = {
  // Respawn in Rivals is several seconds; leave headroom to read and act, but
  // close before they are back in the fight holding a stale instruction.
  death:      { windowMs: 7000,  priority: 4 },
  teamWipe:   { windowMs: 8000,  priority: 3 },
  objective:  { windowMs: 6000,  priority: 2 },
  roundStart: { windowMs: 10000, priority: 1 },
};

/** At most this many live tips in a single match, whatever happens. */
const MAX_PER_MATCH = 6;

/** And never two inside this, even across different moments. */
const MIN_GAP_MS = 25000;

/**
 * What the screen read has to say for a moment to count.
 *
 * Deliberately narrow. Each of these is a phrase the game itself puts on
 * screen, not an inference about the state of the fight, because the whole
 * point is that the moment is unambiguous. A near miss is not a moment.
 */
const TELLS = {
  death:      [/\brespawn(ing)? in\b/i, /\byou (were|are) (eliminated|defeated)\b/i, /\bkill ?cam\b/i],
  teamWipe:   [/\bteam ?wipe\b/i, /\benemy team eliminated\b/i, /\byour team (was|has been) eliminated\b/i],
  // An EVENT, never a place. "payload" and "convoy" on their own name where the
  // fight is happening, and matching them opened the gate on a frame reading
  // "Iron Man is shooting at Groot near the payload", which is the exact
  // mid-fight interruption this whole file exists to prevent. The verb is what
  // makes it a moment.
  objective:  [/\b(point|objective|payload|convoy)\s+(captured|secured|lost|complete)\b/i,
               /\bcapture complete\b/i, /\bovertime\b/i],
  roundStart: [/\bround \d+\b/i, /\bmatch start\b/i, /\bprepare\b/i, /\bstaging\b/i],
};

/**
 * Which moment, if any, a screen read describes.
 * @param {string} text  what the model reported seeing on screen
 * @returns {string|null}
 */
function momentFrom(text) {
  const t = String(text || '');
  if (!t) return null;
  // Highest priority wins when a frame shows two at once, which happens: a team
  // wipe and your own death are the same instant.
  const names = Object.keys(MOMENTS).sort((a, b) => MOMENTS[b].priority - MOMENTS[a].priority);
  for (const name of names) {
    if (TELLS[name].some((re) => re.test(t))) return name;
  }
  return null;
}

/**
 * The gate itself. One per match.
 *
 * Everything here exists to make the tips rare. A live tip in this game is a
 * strong interruption, so the budget is small and the gaps are long, and both
 * are enforced here rather than trusted to whatever calls it.
 */
function createMomentGate(opts) {
  const o = opts || {};
  const maxPerMatch = o.maxPerMatch || MAX_PER_MATCH;
  const minGapMs = o.minGapMs == null ? MIN_GAP_MS : o.minGapMs;

  let sent = 0;
  let lastAt = 0;
  let hasSent = false;   // NOT `lastAt > 0`: a tip noted at time 0 is still a tip
  let openMoment = null;
  let openedAt = 0;

  return {
    /** A frame arrived. Returns the moment it opened, or null. */
    observe(text, now) {
      const at = now == null ? Date.now() : now;
      const m = momentFrom(text);
      if (!m) return null;
      // A moment already open is not reopened by a second frame showing the
      // same thing, or the window would slide forever while the banner is up.
      if (openMoment === m && at - openedAt < MOMENTS[m].windowMs) return null;
      openMoment = m;
      openedAt = at;
      return m;
    },

    /** May a tip be shown right now? */
    allows(now) {
      const at = now == null ? Date.now() : now;
      if (!openMoment) return false;
      if (at - openedAt > MOMENTS[openMoment].windowMs) return false;   // window closed
      if (sent >= maxPerMatch) return false;
      if (hasSent && at - lastAt < minGapMs) return false;
      return true;
    },

    /** Record that one was actually shown. */
    note(now) {
      sent += 1;
      hasSent = true;
      lastAt = now == null ? Date.now() : now;
      openMoment = null;            // one tip per moment, never two
    },

    reset() { sent = 0; lastAt = 0; hasSent = false; openMoment = null; openedAt = 0; },
    get state() { return { sent, openMoment, maxPerMatch }; },
  };
}

module.exports = { MOMENTS, TELLS, MAX_PER_MATCH, MIN_GAP_MS, momentFrom, createMomentGate };
