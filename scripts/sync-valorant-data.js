#!/usr/bin/env node
'use strict';

/**
 * Sync GhostCoach's Valorant game data from valorant-api.com (a mirror of the
 * game's own files, updated every patch). Regenerates the VERIFIABLE data that
 * used to be hand-maintained and drift out of date, agent roster + roles +
 * ability names, the map pool + which maps have three sites, and the distinctive
 * map callouts, into valorant-data.generated.json.
 *
 * What stays hand-authored (coaching flavor, not facts): the per-agent casual
 * tip, the generic ability kit categories, and community callout names the game
 * files do not use (Hookah, Showers). Those live in code and are merged on top.
 *
 * Run:  npm run sync:valorant
 * Then commit the regenerated json files. The client (src/) and server (server/)
 * deploy separately, so an identical copy is written to each.
 */

const fs = require('fs');
const path = require('path');

const AGENTS_URL = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const MAPS_URL   = 'https://valorant-api.com/v1/maps';

// Ability slots that a player actively USES (a tip can tell them to). Passive is
// never a "use your X" instruction, so it is excluded.
const USED_SLOTS = new Set(['Ability1', 'Ability2', 'Grenade', 'Ultimate']);

// Generic or ambiguous region names that must NOT gate a tip: common English
// words (a tip may use them non-locationally) and spots on so many maps they
// carry no map signal. The callout->map assignments still come from the API.
const CALLOUT_DENY = new Set([
  'site', 'spawn', 'main', 'top', 'bottom', 'hall', 'lobby', 'link', 'window',
  'tower', 'cubby', 'back', 'ramp', 'ramps', 'stairs', 'door', 'doors', 'exit',
  'short', 'long', 'box', 'angle box', 'flat box', 'pit', 'yard', 'drop', 'bend',
  'wall', 'bridge', 'screen', 'screens', 'connector', 'secret', 'rafters', 'gate',
  'bench', 'pillar', 'pillars', 'arches', 'arch', 'water', 'alley', 'garden',
  'courtyard', 'fountain', 'generator', 'elbow', 'plaza', 'shops', 'shop', 'hut',
  'upper', 'tiles', 'pocket', 'danger', 'security', 'cave', 'rope', 'ropes',
  'belt', 'blue', 'green', 'orange', 'yellow', 'fence', 'pallet', 'pipes',
  'snow pile', 'wood doors', 'boat house', 'art', 'club', 'records', 'restaurant',
  'gym', 'trophy', 'sandbags', 'horseshoe', 'root',
]);

// Famous community callouts the game files name differently. Kept so the gate
// still catches the real terms players (and the coach) use.
const COMMUNITY_CALLOUTS = { hookah: ['bind'], showers: ['bind'] };

// Only a callout on this few standard maps is distinctive enough to gate on.
const MAX_MAPS_FOR_DISTINCTIVE = 3;

// Super-regions that are spawn areas, not places a tip should ever send the
// player. Kept in the geometry (so the locator can still NAME them when the
// player is standing there) but never offered as a destination.
const SPAWN_SUPERS = new Set(['attacker side', 'defender side']);

// Places the game files name one thing and every player calls another. Stored
// as an alias ON the real callout (never a second entry at the same point, that
// would make the location read ambiguous and lose the precision), so the coach
// can say the word the player actually uses.
// Keyed by map, then by the game's own callout name.
const COMMUNITY_ALIASES = {
  bind: { 'B Window': 'Hookah', 'A Bath': 'Showers' },
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.data)) throw new Error(`${url} -> no data array`);
  return j.data;
}

function buildAgents(rows) {
  const agents = {};
  for (const a of rows) {
    if (!a.displayName || !a.role || !Array.isArray(a.abilities)) continue;
    const abilities = a.abilities
      .filter((ab) => USED_SLOTS.has(ab.slot) && ab.displayName)
      .map((ab) => String(ab.displayName).toLowerCase().trim())
      .filter(Boolean);
    agents[a.displayName] = { role: a.role.displayName, abilities };
  }
  return agents;
}

// A standard plant/defuse map has a tacticalDescription ("A/B Sites" or
// "A/B/C Sites"); Team Deathmatch and tutorial maps have null.
function isStandardMap(m) {
  return !!(m.displayName && m.tacticalDescription && Array.isArray(m.callouts) && m.callouts.length);
}

function buildMaps(rows) {
  const standard = rows.filter(isStandardMap);
  const maps = standard.map((m) => m.displayName).sort();
  const threeSite = standard
    .filter((m) => /\bc\b/i.test(m.tacticalDescription))   // "A/B/C Sites"
    .map((m) => m.displayName).sort();
  return { maps, threeSiteMaps: threeSite, standardRows: standard };
}

function buildCallouts(standardRows) {
  const byCallout = {};
  for (const m of standardRows) {
    const map = m.displayName.toLowerCase();
    const seen = new Set();
    for (const c of m.callouts) {
      const n = (c.regionName || '').toLowerCase().trim();
      if (!n || CALLOUT_DENY.has(n) || seen.has(n)) continue;
      seen.add(n);
      (byCallout[n] = byCallout[n] || new Set()).add(map);
    }
  }
  const out = {};
  for (const [n, set] of Object.entries(byCallout)) {
    if (set.size <= MAX_MAPS_FOR_DISTINCTIVE) out[n] = [...set].sort();
  }
  for (const [n, maps] of Object.entries(COMMUNITY_CALLOUTS)) out[n] = maps.slice();
  // Stable key order for clean diffs.
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * Convert a callout's world location to a position on the minimap as the player
 * sees it: 0..1 across (left to right) and 0..1 down (top to bottom).
 *
 * This is the game's own transform, shipped in the map data. Note the axis
 * swap, it is not a typo: the world Y drives the minimap X and the world X
 * drives the minimap Y.
 */
function worldToMinimap(loc, m) {
  return {
    x: loc.y * m.xMultiplier + m.xScalarToAdd,
    y: loc.x * m.yMultiplier + m.yScalarToAdd,
  };
}

const r3 = (n) => Math.round(n * 1000) / 1000;

/** "top left", "center", "bottom right", ... from a normalized minimap point. */
function describeSpot(x, y) {
  const col = x < 0.34 ? 'left' : x > 0.66 ? 'right' : 'center';
  const row = y < 0.34 ? 'top'  : y > 0.66 ? 'bottom' : 'middle';
  if (row === 'middle' && col === 'center') return 'dead center';
  if (col === 'center') return row + ' center';
  if (row === 'middle') return 'middle ' + col;
  return row + ' ' + col;
}

/**
 * Per-map minimap geometry: every real callout placed on the minimap, plus the
 * centroid of each super-region (A, B, C, Mid). This is what lets the coach
 * turn "the yellow arrow is 40% across, 70% down" into a callout that is
 * guaranteed to exist on THIS map, instead of guessing a name from memory.
 */
function buildGeometry(standardRows) {
  const out = {};
  for (const m of standardRows) {
    if (typeof m.xMultiplier !== 'number' || typeof m.yMultiplier !== 'number') continue;

    const aliases = COMMUNITY_ALIASES[m.displayName.toLowerCase()] || {};
    const callouts = [];
    const superPts = {};
    for (const c of m.callouts) {
      if (!c.location || !c.regionName || !c.superRegionName) continue;
      const p = worldToMinimap(c.location, m);
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      const sup    = String(c.superRegionName).trim();
      const region = String(c.regionName).trim();
      // "A" + "Main" -> "A Main"; avoid "Mid Mid" style doubles.
      const name = region.toLowerCase() === sup.toLowerCase() ? region : `${sup} ${region}`;
      const entry = { n: name, s: sup, x: r3(p.x), y: r3(p.y) };
      if (aliases[name]) entry.a = aliases[name];   // what players actually call it
      callouts.push(entry);
      (superPts[sup] = superPts[sup] || []).push(p);
    }
    if (!callouts.length) continue;

    // Where each site sits on the minimap, straight from the callout centroids.
    const sites = {};
    for (const [sup, pts] of Object.entries(superPts)) {
      if (SPAWN_SUPERS.has(sup.toLowerCase())) continue;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      sites[sup] = { x: r3(cx), y: r3(cy), where: describeSpot(cx, cy) };
    }

    callouts.sort((a, b) => a.n.localeCompare(b.n));
    out[m.displayName.toLowerCase()] = {
      hasMid: Object.keys(sites).some((s) => /^mid$/i.test(s)),
      sites,
      callouts,
    };
  }
  return out;
}

function diff(label, prev, next) {
  const lines = [];
  const pk = new Set(Object.keys(prev || {}));
  const nk = new Set(Object.keys(next || {}));
  for (const k of nk) if (!pk.has(k)) lines.push(`  + ${label} added: ${k}`);
  for (const k of pk) if (!nk.has(k)) lines.push(`  - ${label} removed: ${k}`);
  for (const k of nk) {
    if (pk.has(k) && JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      lines.push(`  ~ ${label} changed: ${k}  ${JSON.stringify(prev[k])} -> ${JSON.stringify(next[k])}`);
    }
  }
  return lines;
}

async function main() {
  console.log('Fetching valorant-api.com ...');
  const [agentRows, mapRows] = await Promise.all([fetchJson(AGENTS_URL), fetchJson(MAPS_URL)]);

  const agents = buildAgents(agentRows);
  const { maps, threeSiteMaps, standardRows } = buildMaps(mapRows);
  const mapCallouts = buildCallouts(standardRows);
  const mapGeometry = buildGeometry(standardRows);

  const data = {
    generatedAt: new Date().toISOString(),
    source: 'valorant-api.com',
    agents, maps, threeSiteMaps, mapCallouts, mapGeometry,
  };

  // Diff against the current client copy so per-patch changes are visible.
  const clientPath = path.join(__dirname, '..', 'src', 'shared', 'valorant-data.generated.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(clientPath, 'utf8')); } catch {}
  const changes = [
    ...diff('agent', prev.agents, agents),
    ...diff('callout', prev.mapCallouts, mapCallouts),
    ...diff('map', Object.fromEntries((prev.maps || []).map((m) => [m, 1])), Object.fromEntries(maps.map((m) => [m, 1]))),
  ];

  const json = JSON.stringify(data, null, 2) + '\n';
  const serverPath = path.join(__dirname, '..', 'server', 'valorant-data.generated.json');
  fs.writeFileSync(clientPath, json);
  fs.writeFileSync(serverPath, json);

  const geoTotal = Object.values(mapGeometry).reduce((s, g) => s + g.callouts.length, 0);
  console.log(`\nAgents: ${Object.keys(agents).length} | Maps: ${maps.length} (3-site: ${threeSiteMaps.join(', ')}) | Callouts: ${Object.keys(mapCallouts).length}`);
  console.log(`Minimap geometry: ${Object.keys(mapGeometry).length} maps, ${geoTotal} placed callouts`);
  console.log(changes.length ? '\nChanges since last sync:\n' + changes.join('\n') : '\nNo changes since last sync.');
  console.log(`\nWrote:\n  ${clientPath}\n  ${serverPath}`);
}

main().catch((e) => { console.error('sync failed:', e.message); process.exit(1); });
