'use strict';

/**
 * The games GhostCoach can coach.
 *
 * One place that answers "what is this app currently about": the name shown to
 * the player, the palette, and, importantly, whether coaching for it actually
 * exists yet. Before this file the answer was implicit, scattered across a
 * hardcoded `game: 'Valorant'` string in two payloads and a require of
 * valorant-data.generated.json at four call sites.
 *
 * `coaching: false` is the honest half of this. A game can be present in the
 * registry, and have a finished palette, long before its coach works. Shipping a
 * picker whose second option silently runs Valorant logic under a different
 * colour scheme would be worse than shipping no picker at all, so an
 * unavailable game is hidden from players entirely and only appears when
 * devGames is switched on in the config.
 */

const GAMES = {
  valorant: {
    id: 'valorant',
    label: 'Valorant',
    // Riot red and cyan on near-black. The historical default, and the reason
    // the brand tokens are still named --red and --cyan.
    palette: null,          // null means "the defaults already in theme.css"
    coaching: true,
    // How the coach works for this game, which differs more than the palette
    // does: Valorant earns a live tip every few seconds, Marvel Rivals does not.
    cadence: 'live',
  },

  rivals: {
    id: 'rivals',
    label: 'Marvel Rivals',
    // Navy, gold and white. Deliberately evocative rather than lifted: the
    // product must not ship Marvel or NetEase assets, and using their exact
    // brand assets would be a trademark problem rather than a styling choice.
    palette: {
      '--bg':        '#0A1330',
      '--bg-2':      '#060C22',
      '--red':       '#FFC42E',   // primary accent, gold
      '--red-2':     '#F2A50C',
      '--red-rgb':   '255, 196, 46',
      '--cyan':      '#5FA8FF',   // secondary accent, a lighter blue
      '--cyan-rgb':  '95, 168, 255',
      '--text':      '#EEF3FF',
      '--text-dim':  '#93A4C8',
      '--text-mute': '#61729A',
      '--glass-fill':   'rgba(10, 19, 48, 0.90)',
      '--glass-fill-2': 'rgba(16, 27, 62, 0.80)',
    },
    // Draft advice and post-match review, not a live tip stream. A 6v6 hero
    // shooter is decided by the hero select screen and by knowing when to
    // switch, and neither is a per-second decision.
    coaching: false,        // flip to true when the Rivals coach actually exists
    // Selectable, and labelled for what it is. The palette, the layout and the
    // whole shell are real and worth looking at; the coach is not built. Saying
    // "Preview" is the difference between a feature you are showing off and a
    // feature that appears broken.
    preview: true,
    cadence: 'draft',
  },
};

const DEFAULT_GAME = 'valorant';

/** The game record for an id, falling back to the default rather than throwing. */
function get(id) {
  return GAMES[String(id || '').toLowerCase()] || GAMES[DEFAULT_GAME];
}

/**
 * Games a player may choose.
 *
 * A game appears once it can be coached OR once it is explicitly marked as a
 * preview. Preview means the shell is real and the coach is not, and the label
 * says so, which is the honest middle ground between hiding work that is
 * genuinely finished and pretending a coach exists that does not.
 *
 * @param includeUnavailable reveals games that are neither coachable nor
 *   marked preview, for development only.
 */
function list(includeUnavailable) {
  return Object.values(GAMES).filter((g) => g.coaching || g.preview || includeUnavailable);
}

/** Is this a game we can actually coach right now? */
function canCoach(id) {
  return !!get(id).coaching;
}

module.exports = { GAMES, DEFAULT_GAME, get, list, canCoach };
