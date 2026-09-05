'use strict';

/**
 * The games Occlara can coach.
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
    // No palette. Rivals used to repaint the whole app navy and gold; it now
    // looks the same whichever game is being coached, so this is null exactly
    // like Valorant's and the :root[data-game="rivals"] block in theme.css is
    // gone. data-game is still set on <html>, so a palette could come back
    // without touching anything but the stylesheet.
    palette: null,
    // Draft advice and post-match review, not a live tip stream. A 6v6 hero
    // shooter is decided by the hero select screen and by knowing when to
    // switch, and neither is a per-second decision.
    // COACHING IS NOT ONE SWITCH, because the two halves are not equally ready.
    //
    // Measured against real capture frames: the post-match review reads a
    // scoreboard essentially perfectly, every figure matching the screen. The
    // draft read does not. It gets the teammate COUNT right and their ROLES
    // wrong, which produced confident advice naming the wrong role on three of
    // four frames, and a higher quality capture made it worse rather than
    // better, so it is not a legibility problem.
    //
    // A single `coaching` boolean forces a choice between shipping the broken
    // half and withholding the good one. So each feature carries its own flag,
    // and the game counts as coachable when any of them is true.
    features: {
      review: true,         // proven against a real scoreboard
      draft: false,         // roles read wrong, see test-rivals-draft
      // No rank, win rate or match history. Every Marvel Rivals tracker derives
      // its data by scraping or community submission, there is no official API,
      // and the one MCP server claiming to be one resolves to a parked survey
      // domain. Stated explicitly rather than left to hasFeature's
      // false-by-absence, because the stats dashboard reads this to decide
      // whether to show Valorant's numbers or an honest blank.
      stats: false,
    },
    // Still labelled honestly in the picker, because only part of it works.
    preview: true,
    cadence: 'draft',
  },

  lol: {
    id: 'lol',
    label: 'League of Legends',
    palette: null,
    // League INVERTS the Rivals problem, and saying so here matters because
    // pattern matching from Rivals gets this wrong in two different ways.
    //
    // 1. Riot's Data Dragon publishes every champion, ability and icon per
    //    patch for third-party use. The "never a portrait" rule written for
    //    Marvel Rivals is a TRADEMARK constraint on NetEase art and it does NOT
    //    carry over here: League can ship real champion icons. Separate from
    //    that is Riot product registration and approval for a PAID product,
    //    which is a permission to obtain rather than a data problem.
    //
    // 2. Riot documents a Live Client Data API on 127.0.0.1:2999 that hands
    //    over exact champion names, scores and events during a match. The thing
    //    that blocks Rivals, knowing who is on screen, does not exist here.
    //    That is a decision to take deliberately rather than drift into,
    //    because it is a NEW KIND OF INPUT for a product whose promise is "we
    //    only capture the display". It is not memory reading, not file access
    //    and not input automation, so it does not break that promise, but the
    //    promise has to be restated rather than quietly widened. It is the Live
    //    Client Data API on 2999, NOT the LCU, which Riot says is unsupported
    //    for third parties.
    //
    // Nothing here uses either yet. This entry only reserves the id so the
    // picker, the config and the palette hook all know the game exists.
    features: {
      learn: true,          // the curriculum surface, no live coaching
      live: false,          // not built, and gated on the decision above
      // Rank, mastery and match history all need a Riot PRODUCTION API key
      // (Account-V1, League-V4, Champion-Mastery-V4, Match-V5). The app has no
      // Riot key of any kind, so there is no League data source at all. Until
      // there is, the dashboard says so instead of showing Valorant's numbers
      // under a League selection.
      stats: false,
    },
    // preview is FALSE, deliberately, and this is the one place the League
    // brief and this registry disagree on a word. Here `preview: true` does not
    // mean "unfinished", it means SHOW IT TO PLAYERS with a preview label, the
    // way Rivals is shown because its shell is genuinely real. League has no
    // shell yet: no data, no surface, nothing to look at. So it stays behind
    // devGames until the learn surface exists, and this flips to true on the
    // day there is something worth previewing. That day is here: 173 champions
    // of real data and a twelve lesson curriculum. `preview` does not mean
    // unfinished, it means shown WITH a preview label, and the label is honest
    // because live coaching genuinely is not built.
    preview: true,
    // Not 'live' and not 'draft'. Learning is a player sitting down to study,
    // which is neither a tip stream nor a one-shot read.
    cadence: 'learn',
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

/**
 * Is this a game we can actually coach right now?
 *
 * True when ANY feature works, since a game whose review is proven and whose
 * draft is not should still review. Valorant carries `coaching: true` and no
 * feature map, so it stays coachable without listing every feature it has.
 */
function canCoach(id) {
  const g = get(id);
  if (g.coaching) return true;
  return Object.values(g.features || {}).some(Boolean);
}

/** Is one specific feature ready for this game? */
function hasFeature(id, name) {
  const g = get(id);
  if (g.features) return !!g.features[name];
  return !!g.coaching;          // a game with no feature map has all of them
}

module.exports = { GAMES, DEFAULT_GAME, get, list, canCoach, hasFeature };
