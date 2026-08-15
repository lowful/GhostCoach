'use strict';

/**
 * Developer joke tips: fake coaching, fired by hand, visible only to you.
 *
 * Off unless `devJokeTips` is true in the config, and that key has NO Settings
 * UI on purpose. There is nothing to stumble into, nothing to toggle by
 * accident, and a normal install can never reach this no matter what it does.
 *
 * THE PART THAT MATTERS MORE THAN THE JOKE: a fake tip must never enter the
 * record. It is broadcast straight to the overlay and deliberately skips
 * state.tips, which is what feeds the session archive, the grade, the habit
 * profile and the weekly report. A joke that quietly became "recurring mistake:
 * dry peeking" in your own weekly report, or dragged a session score down,
 * would corrupt the exact numbers this app spends its life trying to keep
 * honest. It is also kept out of the AI decision log, so a future log review
 * cannot be fooled by a tip the coach never wrote.
 *
 * Every firing is logged with a [joke] tag, so if one ever does turn up in a
 * screenshot there is a line in debug.log explaining it.
 */

// Defaults. `devJokeTipList` in the config overrides this entirely, so you can
// keep your own without touching the source.
const DEFAULT_JOKES = [
  'Uninstall.',
  'Have you considered that the enemy team is simply better than you.',
  'Your crosshair placement is fine, the problem is deeper than that.',
  'DEATH: You died because you are playing Valorant.',
  'Statistically, closing the game now protects your rank.',
  'Try aiming at their head instead of the wall behind them.',
  'The coach has reviewed this round and would rather not comment.',
  'Bold of you to buy a rifle with that K/D.',
  'Consider Minecraft.',
  'Your teammates have been notified of this play.',
];

let cursor = 0;

/** Is the joke channel switched on for this install? */
function enabled(store) {
  try { return store.get('devJokeTips') === true; } catch { return false; }
}

/** The configured list, falling back to the built-in one. */
function jokes(store) {
  let custom = null;
  try { custom = store.get('devJokeTipList'); } catch { /* fall through */ }
  const list = Array.isArray(custom) ? custom.filter((t) => typeof t === 'string' && t.trim()) : [];
  return list.length ? list : DEFAULT_JOKES;
}

/**
 * The next joke, cycling in order rather than at random so pressing the key
 * twice never repeats the same line, which is the one thing that gives it away.
 * @returns {string|null} null when the feature is off
 */
function next(store) {
  if (!enabled(store)) return null;
  const list = jokes(store);
  const tip = list[cursor % list.length];
  cursor++;
  return tip;
}

/** Reset the rotation, used by the tests so ordering is deterministic. */
function reset() { cursor = 0; }

module.exports = { next, enabled, jokes, reset, DEFAULT_JOKES };
