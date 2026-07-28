'use strict';

/**
 * Fact-check the Pro Playbook against the generated Valorant data.
 *
 * The playbook is the one place in this codebase where prose gets fed to the
 * coach as if it were true. A wrong ability or a callout from another map does
 * not crash anything, it just teaches the player something false in a confident
 * voice, which is the worst failure this app has. So every claim that CAN be
 * checked mechanically is checked here.
 *
 * Checked:
 *   - every agent named in an `agents` tag exists
 *   - every map named in a `maps` tag exists
 *   - an agent-tagged note may only name abilities its own agents actually have
 *   - a map-tagged note may only name callouts that exist on those maps
 *   - no em or en dashes, and no curly quotes (they break the tip sanitiser)
 *
 * Run: npm run check:playbook
 */

const path = require('path');
const data = require(path.join(__dirname, '..', 'src', 'shared', 'valorant-data.generated.json'));
const knowledge = require(path.join(__dirname, '..', 'server', 'services', 'knowledge.js'));

const AGENTS = data.agents || {};
const MAPS = (data.maps || []).map((m) => m.toLowerCase());
const CALLOUT_INDEX = data.mapCallouts || {};   // callout(lower) -> [map(lower)]

// Every ability in the game, mapped to the agents that own it. Used to catch a
// note that tells a Jett to use a Sova drone.
const ABILITY_OWNERS = new Map();
for (const [agent, info] of Object.entries(AGENTS)) {
  for (const ability of (info.abilities || [])) {
    const key = String(ability).toLowerCase();
    if (!ABILITY_OWNERS.has(key)) ABILITY_OWNERS.set(key, new Set());
    ABILITY_OWNERS.get(key).add(agent.toLowerCase());
  }
}

// Callouts worth checking: multi word ones, and single words distinctive enough
// that a false one would actually mislead. Bare "mid" or "site" are skipped
// because they are generic English here, not claims about a specific map.
const GENERIC = new Set(['mid', 'site', 'a', 'b', 'c', 'main', 'spawn', 'heaven', 'window', 'link', 'lobby', 'default']);

function calloutsForMap(mapLower) {
  const geo = (data.mapGeometry || {})[mapLower];
  const list = (geo && Array.isArray(geo.callouts)) ? geo.callouts : [];
  return new Set(list.map((c) => String(c.n || '').toLowerCase()).filter(Boolean));
}

const problems = [];
function fail(note, msg) {
  problems.push({ msg, text: String(note.text || '').slice(0, 100) });
}

const notes = knowledge.all ? knowledge.all() : null;
if (!notes) {
  console.error('knowledge.js does not expose all(); add it so the playbook can be checked.');
  process.exit(2);
}

for (const note of notes) {
  const text = String(note.text || '');
  const lower = text.toLowerCase();

  if (/[–—]/.test(text)) fail(note, 'contains an em or en dash');
  if (/[‘’“”]/.test(text)) fail(note, 'contains a curly quote');
  if (!text.trim()) fail(note, 'empty text');

  for (const a of (note.agents || [])) {
    if (!Object.keys(AGENTS).some((k) => k.toLowerCase() === String(a).toLowerCase())) {
      fail(note, `unknown agent "${a}"`);
    }
  }
  for (const m of (note.maps || [])) {
    if (!MAPS.includes(String(m).toLowerCase())) fail(note, `unknown map "${m}"`);
  }

  // An agent-tagged note must not tell that agent to use somebody else's kit.
  if (note.agents && note.agents.length) {
    const owned = new Set();
    for (const a of note.agents) {
      const info = AGENTS[Object.keys(AGENTS).find((k) => k.toLowerCase() === String(a).toLowerCase())];
      for (const ab of ((info && info.abilities) || [])) owned.add(String(ab).toLowerCase());
    }
    for (const [ability, owners] of ABILITY_OWNERS) {
      if (ability.length < 4) continue;
      // Whole words only. A plain substring test flagged "cover" as Harbor's
      // Cove three times over, which is the kind of false alarm that gets a
      // checker switched off.
      if (!new RegExp(`\\b${ability.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) continue;
      if (owned.has(ability)) continue;
      const tagged = note.agents.map((a) => String(a).toLowerCase());
      if (tagged.some((t) => owners.has(t))) continue;
      fail(note, `names "${ability}" which belongs to ${[...owners].join('/')}, not ${note.agents.join('/')}`);
    }
  }

  // A map-tagged note must not name a callout from a different map.
  if (note.maps && note.maps.length) {
    const allowed = new Set();
    for (const m of note.maps) for (const c of calloutsForMap(String(m).toLowerCase())) allowed.add(c);
    for (const [callout, maps] of Object.entries(CALLOUT_INDEX)) {
      if (GENERIC.has(callout) || callout.length < 4) continue;
      if (!new RegExp(`\\b${callout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) continue;
      if (allowed.has(callout)) continue;
      const noteMaps = note.maps.map((m) => String(m).toLowerCase());
      if (maps.map((m) => String(m).toLowerCase()).some((m) => noteMaps.includes(m))) continue;
      fail(note, `names callout "${callout}" which is on ${maps.join('/')}, not ${note.maps.join('/')}`);
    }
  }
}

console.log(`checked ${notes.length} playbook notes`);
if (!problems.length) {
  console.log('PASS: no unknown agents, maps, abilities or foreign callouts');
  process.exit(0);
}
console.log(`FAIL: ${problems.length} problem(s)`);
for (const p of problems) console.log(`  - ${p.msg}\n      "${p.text}"`);
process.exit(1);
