'use strict';

/**
 * Client-side knowledge of every Valorant agent: role, ability names (used by
 * the tip ability-validator and to enrich the context sent to the AI), and a
 * short, casual playstyle reminder used for agent-specific library tips.
 *
 * `abilities` are lowercased for substring matching in the validator.
 */
// Verified game data (roster, roles, ability names) is generated from
// valorant-api.com by `npm run sync:valorant`, so it never drifts when Riot
// adds or reworks an agent. The casual per-agent tip, community ability
// aliases, and generic kit stay hand-authored below and are merged on top.
// If the generated file is ever missing, agent features degrade off, no crash.
let GENERATED = { agents: {} };
try { GENERATED = require('../../shared/valorant-data.generated.json'); }
catch (e) { console.error('[agent-data] generated Valorant data missing, agent features limited:', e.message); }

// Casual, agent-specific playstyle reminder (coaching flavor, not a fact).
const AGENT_TIPS = {
  Jett: 'Use your dash to entry, but save it to bail, don’t ego-peek with it on cooldown.',
  Raze: 'Satchel into site and nade the corners, you’re the space-taker, so trade-bait with your team behind.',
  Reyna: 'Reyna’s only as good as her frags, get a pick, dismiss out, reset. Don’t dry-peek without a soul nearby.',
  Phoenix: 'Flash your own peeks and self-heal off the molly. Use ult to get info for free.',
  Yoru: 'Sell the fake, TP behind them or flank while they watch your decoy.',
  Neon: 'Slide-peek for the speed advantage, stun before you swing, and don’t over-run into their crosshair.',
  Iso: 'Pop your shield before a duel and take the 1v1s, your kit wants isolated fights.',
  Waylay: 'Use Lightspeed to entry and Refract to rewind out of trouble, play fast but reset safe.',
  Brimstone: 'Drop stim for the entry and molly the corners on exec. Your smokes are instant, use them on contact.',
  Viper: 'Manage your fuel, wall the exec, save snakebite for post-plant defuse denial.',
  Omen: 'TP to off-angles and one-way your smokes. Paranoia before you swing for a free duel.',
  Astra: 'Set stars in setup and use the wall to split a site or save a retake.',
  Harbor: 'Wall the exec and bubble the plant, your util takes space, push behind it as a team.',
  Clove: 'You can smoke from anywhere, even dead. Play aggressive, you self-revive off a kill.',
  Sova: 'Recon the site before exec, shock-dart common spots, and lineup post-plant darts.',
  Breach: 'Flash and fault-line through the wall for the team entry, stack your util with the swing.',
  Skye: 'Flash for your team’s entry and trail-blaze to clear corners. Heal the team in setup.',
  'KAY/O': 'Knife to suppress before exec, a suppressed site can’t use util. Flash your own swings.',
  Fade: 'Haunt the site for info, prowler to chase them out, seize to trap for the trade.',
  Gekko: 'Send Wingman to plant or clear, and reclaim your util, Dizzy flashes the whole site.',
  Tejo: 'Drone for info and salvo the choke before your team swings the angle.',
  Killjoy: 'Lock down your flank and stack util on a corner. Save swarm grenades for post-plant.',
  Cypher: 'Trip the flank and cam the choke, info wins your rounds, not frags.',
  Sage: 'Wall to take space or delay a push, slow the exec, and save heal for your star player.',
  Chamber: 'Hold an aggressive angle and TP out after the pick, play the OP off your anchor.',
  Deadlock: 'Mesh the choke and sensor the flank, your wall buys time, don’t waste it early.',
  Vyse: 'Set razorvine on entry paths and flash with arc rose, your steel garden shuts down a buy.',
};

// Community ability terms the game's official names do not use, so a tip that
// says "dash" or "vipers pit" still validates for the right agent.
const ABILITY_ALIASES = {
  Jett: ['dash', 'knives'], Viper: ['vipers pit'], Sova: ['hunters fury'],
  'KAY/O': ['kayo'], Sage: ['barrier', 'slow'],
};

// Merge: verified roster/roles/abilities from the API + hand-authored flavor.
const AGENTS = {};
for (const [name, info] of Object.entries(GENERATED.agents || {})) {
  AGENTS[name] = {
    role: info.role,
    abilities: [...(info.abilities || []), ...(ABILITY_ALIASES[name] || [])],
    tip: AGENT_TIPS[name] || null,
  };
}

const ROLE_TIP = {
  Duelist:    'You’re the entry, take space with util, but make sure your team’s right behind to trade.',
  Controller: 'Your smokes set the tempo, wall for the exec and don’t peek your own one-ways.',
  Initiator:  'Get info and flash for the team’s swing, your util wins the entry, not your aim.',
  Sentinel:   'Lock your flank and hold the site, info and crossfires over frags.',
};

function getAgent(name) {
  return name && AGENTS[name] ? AGENTS[name] : null;
}

function getAbilities(name) {
  const a = getAgent(name);
  return a ? a.abilities : [];
}

function getRole(name) {
  const a = getAgent(name);
  return a ? a.role : null;
}

/** A casual, agent-specific playstyle tip (falls back to a role tip). */
function getAgentTip(name) {
  const a = getAgent(name);
  if (a) return a.tip;
  return null;
}

function roleTip(role) {
  return ROLE_TIP[role] || null;
}

function allNames() {
  return Object.keys(AGENTS);
}

// ── Per-agent generic ability kit ─────────────────────────────────────────────
// The generic ability categories each agent can PERSONALLY deploy. Used to
// reject AI tips that tell you to use something your agent doesn't have (e.g.
// "use your recon dart" while you're on Reyna). Categories used in tips:
// smoke, flash, molly, wall, recon, drone, camera, trap, heal, stun, slow, dash.
const AGENT_KITS = {
  Jett: ['smoke', 'dash'], Raze: ['molly'], Reyna: ['flash'],
  Phoenix: ['flash', 'molly', 'wall'], Yoru: ['flash'], Neon: ['stun', 'wall'],
  Iso: [], Waylay: [],
  Brimstone: ['smoke', 'molly'], Viper: ['smoke', 'wall', 'molly'],
  Omen: ['smoke', 'flash'], Astra: ['smoke', 'stun', 'wall'],
  Harbor: ['wall', 'smoke'], Clove: ['smoke', 'molly'],
  Sova: ['recon', 'drone', 'molly'], Breach: ['flash', 'stun'],
  Skye: ['flash', 'heal', 'recon'], 'KAY/O': ['flash', 'molly'],
  Fade: ['recon', 'trap'], Gekko: ['flash', 'molly', 'recon'], Tejo: ['drone', 'molly'],
  Killjoy: ['trap', 'molly'], Cypher: ['trap', 'camera', 'smoke'],
  Sage: ['wall', 'heal', 'slow'], Chamber: ['trap'],
  Deadlock: ['wall', 'trap'], Vyse: ['trap', 'flash', 'wall'],
};

function agentKit(name) { return AGENT_KITS[name] || null; }

// Generic ability words a tip might tell you to personally deploy.
const ABILITY_CUES = [
  ['smoke',  /\bsmokes?\b/],
  ['flash',  /\bflash(?:es)?\b/],
  ['molly',  /\b(?:moll(?:y|ies)|incendiar(?:y|ies)|fire nade)\b/],
  ['wall',   /\bwalls?\b/],
  ['recon',  /\b(?:recon|recon darts?|recon bolts?)\b/],
  ['drone',  /\bdrones?\b/],
  ['camera', /\b(?:cameras?|spycams?)\b/],
  ['trap',   /\b(?:traps?|trip ?wires?)\b/],
  ['heal',   /\bheals?\b/],
  ['stun',   /\b(?:stuns?|concuss(?:es)?)\b/],
  ['slow',   /\bslows?\b/],
];

// Categories the tip tells the PLAYER to personally deploy: an ability word
// preceded (within a few words) by "your" or a deploy verb. "their smoke" or
// "play off the smoke" won't trip it, only a personal instruction does.
// Regexes precompiled once; this runs on every AI tip.
const PERSONAL_CUES = ABILITY_CUES.map(([cat, re]) => {
  const core = re.source.replace(/\\b/g, '');
  return [cat, new RegExp(
    '\\b(?:your|use|using|pop|throw|deploy|drop|put|place|cast|set up|line ?up)\\b[\\w\\s]{0,12}?' + core, 'i')];
});

function personalAbilityCues(text) {
  const l = String(text).toLowerCase();
  const out = [];
  for (const [cat, near] of PERSONAL_CUES) {
    if (near.test(l)) out.push(cat);
  }
  return out;
}

/**
 * Does this AI tip tell the player to use an ability their agent can't?
 *   - agent known  → true if any personally-cued category isn't in its kit.
 *   - agent unknown → true if it personally cues ANY specific ability (we can't
 *     verify what they're on, so we don't risk a wrong-ability tip).
 */
function tipMisusesAbility(text, agentName) {
  const cues = personalAbilityCues(text);
  if (cues.length === 0) return false;
  const kit = agentKit(agentName);
  if (!kit) return true;
  return cues.some((c) => !kit.includes(c));
}

// Every distinctive agent ability NAME (multi-word, slash, or 6+ chars, so we
// skip common words). Used to block ANY named ability before the agent is
// confirmed, e.g. "stim beacon", "recon bolt", "dark cover".
const ALL_ABILITY_NAMES = (() => {
  const set = new Set();
  for (const n of Object.keys(AGENTS)) {
    for (const ab of AGENTS[n].abilities) {
      if (ab.includes(' ') || ab.includes('/') || ab.length >= 6) set.add(ab);
    }
  }
  return [...set];
})();
const ALL_ABILITY_RE = new RegExp(
  '\\b(' + ALL_ABILITY_NAMES.map((a) => a.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') + ')\\b', 'i');

/** Does the tip name any specific agent ability (used to gate on confirmation)? */
function mentionsSpecificAbility(text) {
  return ALL_ABILITY_RE.test(String(text || '').toLowerCase());
}

/** Resolve free-typed user input to a canonical agent name, or null. */
function resolveName(input) {
  if (!input) return null;
  const norm = String(input).toLowerCase().replace(/[^a-z]/g, '');
  if (!norm) return null;
  for (const name of Object.keys(AGENTS)) {
    if (name.toLowerCase().replace(/[^a-z]/g, '') === norm) return name;
  }
  for (const name of Object.keys(AGENTS)) {
    const n = name.toLowerCase().replace(/[^a-z]/g, '');
    if (n.startsWith(norm) || norm.startsWith(n)) return name;
  }
  return null;
}

// ── Ability genericisation ────────────────────────────────────────────────────
// Players think in plain terms ("smoke", "flash", "molly"), not agent-specific
// ability names. Rewriting AI tips to these generic words means the coach never
// tells you to use a named ability that isn't even on your team (e.g. "Omen dark
// cover" when there's no Omen) and reads the way callouts actually sound.
// Ordered longest-first so multi-word names match before single words.
const ABILITY_GENERICS = [
  // smokes / vision blockers
  [/\bsky smokes?\b/gi, 'smoke'],
  [/\bdark covers?\b/gi, 'smoke'],
  [/\bpoison clouds?\b/gi, 'smoke'],
  [/\bcloudbursts?\b/gi, 'smoke'],
  [/\bcyber cages?\b/gi, 'smoke'],
  [/\bnebulas?\b/gi, 'smoke'],
  // walls
  [/\btoxic screens?\b/gi, 'wall'],
  [/\bbarrier orbs?\b/gi, 'wall'],
  [/\bcosmic divide\b/gi, 'wall'],
  [/\bhigh tide\b/gi, 'wall'],
  [/\bbarrier mesh\b/gi, 'wall'],
  // flashes
  [/\bcurveballs?\b/gi, 'flash'],
  [/\bflashpoints?\b/gi, 'flash'],
  [/\bguiding lights?\b/gi, 'flash'],
  [/\bblindsides?\b/gi, 'flash'],
  [/\bfakeouts?\b/gi, 'flash'],
  [/\bflash\/drive\b/gi, 'flash'],
  [/\bparanoia\b/gi, 'flash'],
  [/\barc rose\b/gi, 'flash'],
  // mollies / incendiaries
  [/\bincendiar(?:y|ies)\b/gi, 'molly'],
  [/\bsnake ?bites?\b/gi, 'molly'],
  [/\bhot hands\b/gi, 'molly'],
  [/\baftershocks?\b/gi, 'molly'],
  [/\bnanoswarms?\b/gi, 'molly'],
  [/\bpaint shells\b/gi, 'molly'],
  // recon / info
  [/\brecon bolts?\b/gi, 'recon dart'],
  [/\bowl drones?\b/gi, 'drone'],
  [/\bstealth drones?\b/gi, 'drone'],
  [/\bspycams?\b/gi, 'camera'],
];

const AGENT_LOWER = new Set(Object.keys(AGENTS).map((n) => n.toLowerCase()));
const AGENT_ALT   = [...AGENT_LOWER].map((n) => n.replace(/[/]/g, '\\/')).join('|');
const GENERIC_ALT = 'recon dart|smoke|flash|molly|wall|recon|drone|camera';
// Precompiled once, these run on every AI tip.
const AGENT_BEFORE_GENERIC_RE = new RegExp(`\\b(?:${AGENT_ALT})\\s+(${GENERIC_ALT})\\b`, 'gi');
const YOUR_AGENT_RE           = new RegExp(`\\byour\\s+(?:${AGENT_ALT})\\b`, 'gi');

/**
 * Rewrite an AI tip into plain Valorant lingo: strip agent-name possessives,
 * collapse "use <Agent>" → "use your", and swap named abilities for generic
 * words. Only meant for server AI tips (library/own-agent tips are already
 * phrased correctly).
 */
function genericizeAbilities(text) {
  if (!text) return text;
  let t = String(text);
  // "<Agent>'s ..." → "your ..." (handles straight and curly apostrophes)
  t = t.replace(/\b([a-z][a-z/]+)['’]s\b/gi, (m, name) =>
    AGENT_LOWER.has(name.toLowerCase()) ? 'your' : m);
  // "use/pop/throw/deploy/drop <Agent> ..." → "<verb> your ..."
  t = t.replace(/\b(use|pop|throw|deploy|drop)\s+([a-z][a-z/]+)\b/gi, (m, verb, name) =>
    AGENT_LOWER.has(name.toLowerCase()) ? `${verb} your` : m);
  // Swap named abilities for the plain word a player thinks in.
  for (const [re, rep] of ABILITY_GENERICS) t = t.replace(re, rep);
  // Drop a leftover bare agent name sitting in front of a generic ability word
  // ("Viper wall" → "wall") or right after "your" ("your Sage" → "your").
  t = t.replace(AGENT_BEFORE_GENERIC_RE, '$1');
  t = t.replace(YOUR_AGENT_RE, 'your');
  // Tidy any residue from the swaps.
  t = t.replace(/\byour['’]s\b/gi, 'your')
       .replace(/\byour(\s+your)+\b/gi, 'your')
       .replace(/\s{2,}/g, ' ')
       .replace(/\s+([.,!?])/g, '$1');
  return t.trim();
}

module.exports = {
  AGENTS, getAgent, getAbilities, getRole, getAgentTip, roleTip, allNames,
  genericizeAbilities, agentKit, tipMisusesAbility, mentionsSpecificAbility, resolveName,
};
