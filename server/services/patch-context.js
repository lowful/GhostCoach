'use strict';

/**
 * What changed in the Valorant patch the player is actually on, in Riot's own
 * words. Keeps the coach from teaching a habit that a patch already nerfed.
 *
 * Deliberately narrow: only the lines touching the player's own agent or the
 * gun in their hands, plus the patch's headline changes. The prompt is already
 * long and every extra line costs latency on a live tip, so a change that
 * cannot affect this player is left out entirely.
 *
 * Data comes from npm run sync:patch (verbatim, never summarised).
 */

let PATCH = null;
try {
  PATCH = require('../patch-notes.generated.json');
} catch (e) {
  // Not fatal: the coach simply works without patch awareness.
}

// Bug fixes rarely change how anyone should play; they only earn a slot when
// they touch the player's own agent.
const BUGFIX = /^fixed an issue|^fixed a bug|^fixed /i;

const MAX_OWN     = 4;   // lines about the player's agent or weapon
const MAX_GENERAL = 3;   // headline changes worth knowing regardless

function mentions(change, name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  return (change.names || []).some((x) => String(x).toLowerCase() === n);
}

/** True when we have usable patch data. */
function available() {
  return !!(PATCH && PATCH.patch);
}

/** The live patch number, e.g. "13.01". */
function current() {
  return PATCH && PATCH.patch ? PATCH.patch : null;
}

/**
 * A short patch block for the coaching prompt, tailored to this player.
 * Returns '' when there is nothing worth saying.
 */
function patchBrief(agent, weapon) {
  if (!available()) return '';
  const changes = Array.isArray(PATCH.changes) ? PATCH.changes : [];

  // Balance changes only. A bug fix restores intended behaviour, it does not
  // change how anyone should play, so it is pure prompt weight.
  const balance = changes.filter((c) => !BUGFIX.test(c.line));

  // Changes to the player's own agent or current gun: these can actually
  // change what the right advice is.
  const own = balance
    .filter((c) => mentions(c, agent) || mentions(c, weapon))
    .slice(0, MAX_OWN);

  const general = balance
    .filter((c) => !own.includes(c) && c.type !== 'map')
    .slice(0, MAX_GENERAL);

  if (!own.length && !general.length && !PATCH.headline) return '';

  const lines = [];
  if (own.length) {
    lines.push(`Changes to what THIS player is using${agent ? ' (' + agent + ')' : ''}:`);
    for (const c of own) lines.push('- ' + c.line);
  }
  if (general.length) {
    lines.push(own.length ? 'Other changes this patch:' : 'Changes this patch:');
    for (const c of general) lines.push('- ' + c.line);
  }

  return `\n\nCURRENT PATCH ${PATCH.patch}${PATCH.headline ? ', ' + PATCH.headline : ''} These are Riot's own words, quoted exactly:
${lines.join('\n')}
Use this ONLY when it actually changes the advice, for example do not coach a habit these notes just nerfed, and do lean on something they just buffed. Never mention the patch, a version number, or "the notes" out loud, the player wants coaching, not a changelog. If nothing here affects this frame, ignore it completely.`;
}

module.exports = { patchBrief, available, current };
