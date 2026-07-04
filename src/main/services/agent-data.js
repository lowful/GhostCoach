'use strict';

/**
 * Client-side knowledge of every Valorant agent: role, ability names (used by
 * the tip ability-validator and to enrich the context sent to the AI), and a
 * short, casual playstyle reminder used for agent-specific library tips.
 *
 * `abilities` are lowercased for substring matching in the validator.
 */
const AGENTS = {
  // ── Duelists ────────────────────────────────────────────────────────────────
  Jett:    { role: 'Duelist', abilities: ['cloudburst', 'updraft', 'tailwind', 'blade storm', 'dash', 'knives'], tip: 'Use your dash to entry, but save it to bail, don’t ego-peek with it on cooldown.' },
  Raze:    { role: 'Duelist', abilities: ['boom bot', 'blast pack', 'paint shells', 'showstopper', 'satchel'], tip: 'Satchel into site and nade the corners, you’re the space-taker, so trade-bait with your team behind.' },
  Reyna:   { role: 'Duelist', abilities: ['leer', 'devour', 'dismiss', 'empress'], tip: 'Reyna’s only as good as her frags, get a pick, dismiss out, reset. Don’t dry-peek without a soul nearby.' },
  Phoenix: { role: 'Duelist', abilities: ['blaze', 'curveball', 'hot hands', 'run it back'], tip: 'Flash your own peeks and self-heal off the molly. Use ult to get info for free.' },
  Yoru:    { role: 'Duelist', abilities: ['fakeout', 'blindside', 'gatecrash', 'dimensional drift'], tip: 'Sell the fake, TP behind them or flank while they watch your decoy.' },
  Neon:    { role: 'Duelist', abilities: ['fast lane', 'relay bolt', 'high gear', 'overdrive'], tip: 'Slide-peek for the speed advantage, stun before you swing, and don’t over-run into their crosshair.' },
  Iso:     { role: 'Duelist', abilities: ['contingency', 'undercut', 'double tap', 'kill contract'], tip: 'Pop your shield before a duel and take the 1v1s, your kit wants isolated fights.' },
  Waylay:  { role: 'Duelist', abilities: ['saturate', 'lightspeed', 'refract', 'convergent paths'], tip: 'Use Lightspeed to entry and Refract to rewind out of trouble, play fast but reset safe.' },

  // ── Controllers ─────────────────────────────────────────────────────────────
  Brimstone: { role: 'Controller', abilities: ['incendiary', 'stim beacon', 'sky smoke', 'orbital strike'], tip: 'Drop stim for the entry and molly the corners on exec. Your smokes are instant, use them on contact.' },
  Viper:     { role: 'Controller', abilities: ['snake bite', 'poison cloud', 'toxic screen', 'viper’s pit', 'vipers pit'], tip: 'Manage your fuel, wall the exec, save snakebite for post-plant defuse denial.' },
  Omen:      { role: 'Controller', abilities: ['shrouded step', 'paranoia', 'dark cover', 'from the shadows'], tip: 'TP to off-angles and one-way your smokes. Paranoia before you swing for a free duel.' },
  Astra:     { role: 'Controller', abilities: ['gravity well', 'nova pulse', 'nebula', 'cosmic divide'], tip: 'Set stars in setup and use the wall to split a site or save a retake.' },
  Harbor:    { role: 'Controller', abilities: ['cascade', 'cove', 'high tide', 'reckoning'], tip: 'Wall the exec and bubble the plant, your util takes space, push behind it as a team.' },
  Clove:     { role: 'Controller', abilities: ['pick-me-up', 'meddle', 'ruse', 'not dead yet'], tip: 'You can smoke from anywhere, even dead. Play aggressive, you self-revive off a kill.' },

  // ── Initiators ──────────────────────────────────────────────────────────────
  Sova:    { role: 'Initiator', abilities: ['owl drone', 'shock bolt', 'recon bolt', 'hunter’s fury', 'hunters fury'], tip: 'Recon the site before exec, shock-dart common spots, and lineup post-plant darts.' },
  Breach:  { role: 'Initiator', abilities: ['aftershock', 'flashpoint', 'fault line', 'rolling thunder'], tip: 'Flash and fault-line through the wall for the team entry, stack your util with the swing.' },
  Skye:    { role: 'Initiator', abilities: ['regrowth', 'trailblazer', 'guiding light', 'seekers'], tip: 'Flash for your team’s entry and trail-blaze to clear corners. Heal the team in setup.' },
  'KAY/O': { role: 'Initiator', abilities: ['frag/ment', 'flash/drive', 'zero/point', 'null/cmd', 'kayo'], tip: 'Knife to suppress before exec, a suppressed site can’t use util. Flash your own swings.' },
  Fade:    { role: 'Initiator', abilities: ['prowler', 'seize', 'haunt', 'nightfall'], tip: 'Haunt the site for info, prowler to chase them out, seize to trap for the trade.' },
  Gekko:   { role: 'Initiator', abilities: ['mosh pit', 'wingman', 'dizzy', 'thrash'], tip: 'Send Wingman to plant or clear, and reclaim your util, Dizzy flashes the whole site.' },
  Tejo:    { role: 'Initiator', abilities: ['stealth drone', 'special delivery', 'guided salvo', 'armageddon'], tip: 'Drone for info and salvo the choke before your team swings the angle.' },

  // ── Sentinels ───────────────────────────────────────────────────────────────
  Killjoy:  { role: 'Sentinel', abilities: ['alarmbot', 'nanoswarm', 'turret', 'lockdown'], tip: 'Lock down your flank and stack util on a corner. Save swarm grenades for post-plant.' },
  Cypher:   { role: 'Sentinel', abilities: ['trapwire', 'cyber cage', 'spycam', 'neural theft'], tip: 'Trip the flank and cam the choke, info wins your rounds, not frags.' },
  Sage:     { role: 'Sentinel', abilities: ['barrier orb', 'slow orb', 'healing orb', 'resurrection', 'barrier', 'slow'], tip: 'Wall to take space or delay a push, slow the exec, and save heal for your star player.' },
  Chamber:  { role: 'Sentinel', abilities: ['trademark', 'headhunter', 'rendezvous', 'tour de force'], tip: 'Hold an aggressive angle and TP out after the pick, play the OP off your anchor.' },
  Deadlock: { role: 'Sentinel', abilities: ['gravnet', 'sonic sensor', 'barrier mesh', 'annihilation'], tip: 'Mesh the choke and sensor the flank, your wall buys time, don’t waste it early.' },
  Vyse:     { role: 'Sentinel', abilities: ['shear', 'arc rose', 'razorvine', 'steel garden'], tip: 'Set razorvine on entry paths and flash with arc rose, your steel garden shuts down a buy.' },
};

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
  genericizeAbilities, agentKit, tipMisusesAbility, resolveName,
};
