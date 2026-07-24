'use strict';

/**
 * Deterministic map location: turn a point on the minimap into a callout that
 * is GUARANTEED to exist on the map being played.
 *
 * The model used to name the player's location from memory, which is where the
 * bad callouts came from (Hookah on Haven, sites that map does not have). Here
 * the model only reports WHERE the yellow arrow sits, 0..1 across and down the
 * minimap, and this module does the naming from the game's own callout
 * coordinates. A wrong reading can now only pick the wrong REAL callout on the
 * right map; it can never invent one.
 *
 * Coordinates come from valorant-data.generated.json (npm run sync:valorant),
 * so a new map or a renamed region flows in with the next sync.
 */

let GEOMETRY = {};
try {
  GEOMETRY = require('../valorant-data.generated.json').mapGeometry || {};
} catch (e) {
  console.warn('[callout] generated map geometry unavailable:', e.message);
}

// How far the arrow may sit from a callout before we refuse to name it. The
// minimap is 1.0 wide, callouts are dense (about 23 per map), so a genuine
// read lands well inside this. Beyond it we would be guessing.
const MAX_DISTANCE = 0.13;

// Two callouts this close together are effectively the same place; when the
// runner-up is within this margin the read is ambiguous and we fall back to the
// site name rather than committing to a spot that could be either.
const AMBIGUOUS_MARGIN = 0.02;

function geometryFor(map) {
  if (!map || typeof map !== 'string') return null;
  return GEOMETRY[map.toLowerCase().trim()] || null;
}

/** Is this a map we have verified geometry for? */
function hasGeometry(map) { return !!geometryFor(map); }

/**
 * Nearest real callout to a normalized minimap point.
 * Returns { name, superRegion, distance, confident, ambiguous } or null.
 */
function locate(map, x, y) {
  const geo = geometryFor(map);
  if (!geo || !Array.isArray(geo.callouts) || !geo.callouts.length) return null;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!isFinite(x) || !isFinite(y)) return null;

  let best = null;
  let runnerUp = Infinity;
  for (const c of geo.callouts) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (!best || d < best.d) {
      if (best) runnerUp = best.d;
      best = { c, d };
    } else if (d < runnerUp) {
      runnerUp = d;
    }
  }
  if (!best || best.d > MAX_DISTANCE) return null;

  const ambiguous = runnerUp - best.d < AMBIGUOUS_MARGIN;
  return {
    // Prefer what players actually say ("Hookah" over the game file's "B Window").
    name:        best.c.a || best.c.n,
    superRegion: best.c.s,
    distance:    Math.round(best.d * 1000) / 1000,
    // A tight, unambiguous read is safe to state as the player's location.
    confident:   best.d <= 0.08 && !ambiguous,
    ambiguous,
  };
}

/**
 * The location we are willing to put in front of the coach. When the nearest
 * callout is ambiguous we deliberately widen to the site ("A", "Mid") instead
 * of naming a specific spot we are not sure about, because a confidently wrong
 * callout is worse for the player than a vaguer right one.
 */
function resolveSpot(map, x, y) {
  const hit = locate(map, x, y);
  if (!hit) return null;
  if (hit.confident) return { spot: hit.name, precision: 'exact', ...hit };
  const sup = hit.superRegion || '';
  // "A" -> "A site"; "Mid"/"Attacker Side" read fine as they are.
  const wide = /^[abc]$/i.test(sup) ? `${sup.toUpperCase()} site` : sup;
  return { spot: wide || hit.name, precision: 'area', ...hit };
}

/**
 * A short, factual brief on the map the player is actually on: where each site
 * sits on the minimap and every callout that legitimately exists there. Giving
 * the model the real layout is what stops it reading the minimap from a vague
 * memory of the wrong map.
 */
function minimapBrief(map) {
  const geo = geometryFor(map);
  if (!geo) return '';
  const name = String(map).trim();

  const sites = Object.entries(geo.sites || {})
    .map(([s, v]) => `${s} is ${v.where} of the minimap`)
    .join(', ');

  // The full legal vocabulary, including the community names for spots the game
  // files label differently, so a correct "Hookah" is never rejected.
  const names = [...new Set(geo.callouts.flatMap((c) => (c.a ? [c.a, c.n] : [c.n])))].join(', ');

  const midLine = geo.hasMid
    ? `${name} HAS a mid, so "mid" is a real place to send the player.`
    : `${name} has NO mid. Never say "mid" on this map, it does not exist here.`;

  return `\n\nTHIS MAP'S MINIMAP (verified from the game's own map data, trust it over memory):
On ${name}: ${sites}. ${midLine}
The ONLY callouts that exist on ${name}: ${names}.
Never use a callout that is not in that list, it belongs to a different map and the tip will be wrong.`;
}

module.exports = { locate, resolveSpot, minimapBrief, hasGeometry };
