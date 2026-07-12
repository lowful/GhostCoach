'use strict';

/**
 * The Pro Playbook: a tagged, queryable library of proven high-elo Valorant
 * habits (distilled from Radiant, Immortal, and pro play). Instead of pasting
 * the same static list into every prompt, retrieve() scores each note against
 * the CURRENT match situation (agent, map, side, phase, economy, streaks) and
 * returns only the most relevant few, so a Jett on Ascent attack in a force
 * buy round gets Jett, Ascent, attack, and force buy knowledge, not filler.
 *
 * Growing the playbook needs NO code changes:
 *   - add entries to PLAYBOOK below, or
 *   - drop extra entries into server/data/playbook.json (same shape), which is
 *     merged at startup. That file is where knowledge extracted from coaching
 *     videos and pro VODs lands (transcribe, extract rules with an LLM, tag,
 *     append). The coach is smarter on the very next request.
 *
 * Note shape (every tag optional; untagged notes apply everywhere):
 *   {
 *     text:       'one concrete sentence, comma punctuation only',
 *     side:       'attack' | 'defense',
 *     phase:      'buy' | 'active' | 'postplant' | 'dead',
 *     situations: ['pistol','eco','forcebuy','fullbuy','deathstreak',
 *                  'winstreak','retake','clutch','early'],
 *     roles:      ['duelist','controller','initiator','sentinel'],
 *     agents:     ['Jett', ...],   // only served once the agent is CONFIRMED
 *     maps:       ['Ascent', ...],
 *     weight:     1..3             // base priority (default 1)
 *   }
 */

const fs   = require('fs');
const path = require('path');

const PLAYBOOK = [
  // ── universal fundamentals ──────────────────────────────────────────────
  { text: 'Clear one angle at a time from cover, never wide swing into multiple uncleared angles at once.', weight: 3 },
  { text: 'Keep your crosshair at head height on the edge of the nearest corner, pre aim where a head will appear.', weight: 3 },
  { text: 'Counter strafe before shooting, release your movement key, tap the opposite one, and fire the first accurate shot.', weight: 2 },
  { text: 'Reposition immediately after a kill, repeeking the same pixel is how you hand the kill back.', weight: 3 },
  { text: 'Only take fights with a trade partner in view, if nobody can trade your death, do not take the duel.', weight: 3 },
  { text: 'Jiggle peek for info with quick side taps, wide swing only when you intend to commit to the fight.', weight: 2 },
  { text: 'Glance at the minimap every 5 seconds, most deaths were visible on the map before they happened.', weight: 3 },
  { text: 'Count footsteps and call them, sound tells you enemy numbers before your eyes do.', weight: 1 },
  { text: 'Shift walk once you are within earshot of enemies, run only while your position is not useful information.', weight: 1 },
  { text: 'Play the range of your gun, a Spectre wants close angles, rifles want mid range, an Operator wants the longest sightline.', weight: 1 },

  // ── attack ──────────────────────────────────────────────────────────────
  { side: 'attack', text: 'Default for info first, take map control with util, then commit to a site as five once you have a read.', weight: 3 },
  { side: 'attack', text: 'Trade your entry, when your duelist swings you swing within one second, not after they die.', weight: 3 },
  { side: 'attack', text: 'Use util before contact, flash or smoke the angle you fear, then peek off your own utility.', weight: 3 },
  { side: 'attack', text: 'Save one smoke or flash for the post plant, a naked post plant loses to any organized retake.', weight: 2 },
  { side: 'attack', text: 'If all the noise is on one site, the opposite lurk gets a free flank or a free read, use the weak side.', weight: 1 },
  { side: 'attack', text: 'Push tempo through space your team already owns, do not re clear what is already held.', weight: 1 },
  { side: 'attack', text: 'If the entry dies untraded, regroup and reset the hit, do not trickle one by one into the same angle.', weight: 2 },
  { side: 'attack', text: 'Lurk with purpose, cut the rotation or catch the flank exactly when your team hits, not while they wait.', weight: 1 },
  { side: 'attack', phase: 'postplant', text: 'Plant for cover, then play off site with crossed angles on the spike, never stand on top of it.', weight: 3 },
  { side: 'attack', phase: 'postplant', text: 'Hold the defuse from range with a molly or ability lined up, utility wins post plants without a duel.', weight: 3 },
  { side: 'attack', phase: 'postplant', text: 'Up a player in the post plant, play time, every second without a fight is a second won.', weight: 2 },

  // ── defense ─────────────────────────────────────────────────────────────
  { side: 'defense', text: 'Hold an off angle for the first peek, then change spots, defenders die getting pre aimed in default positions.', weight: 3 },
  { side: 'defense', text: 'Set crossfires so any entry gets shot from two angles, a solo site hold needs util to delay, not duels.', weight: 3 },
  { side: 'defense', text: 'Delay a committed push with utility, you only need to buy seconds for your rotation to arrive.', weight: 2 },
  { side: 'defense', text: 'Do not over peek after your opening kill, give ground, they now have to find you all over again.', weight: 2 },
  { side: 'defense', text: 'Call the push early and loud, a 5 second earlier rotate call wins the retake before it starts.', weight: 1 },
  { side: 'defense', phase: 'postplant', situations: ['retake'], text: 'Retake as a unit behind util, flash or smoke the planter cover and swing together, never one by one.', weight: 3 },
  { side: 'defense', phase: 'postplant', situations: ['retake'], text: 'Play the defuse math, full defuse is 7 seconds and half is 3.5, tap the half defuse to bait their peek.', weight: 2 },
  { side: 'defense', phase: 'postplant', text: 'If the retake is not winnable, save your gun and util, winning the next two rounds beats a hero attempt.', weight: 2 },

  // ── economy ─────────────────────────────────────────────────────────────
  { phase: 'buy', situations: ['eco'], text: 'Under 2000 credits full save, stack a site together or play for one close range pick, do not spread thin.', weight: 3 },
  { phase: 'buy', situations: ['pistol'], text: 'Pistol round buy is light shields plus one cheap ability, or a Ghost, never full armor.', weight: 3 },
  { phase: 'buy', situations: ['pistol'], text: 'Pistols reward the first accurate headshot, take close fights and burst, do not spray at range.', weight: 2 },
  { phase: 'buy', situations: ['forcebuy'], text: 'On a force buy take close fights, a Spectre or shotgun loses every long range duel to a rifle.', weight: 3 },
  { phase: 'buy', situations: ['fullbuy'], text: 'Buy your utility with the rifle, a full buy with no util is half a buy at high level.', weight: 2 },
  { phase: 'buy', text: 'Match your team buy, a solo force next to four saves wastes both rounds, buy together or save together.', weight: 3 },
  { phase: 'buy', text: 'Sitting above 6000 with a teammate on a save, offer the drop, team economy wins matches.', weight: 1 },

  // ── streaks and mental ──────────────────────────────────────────────────
  { situations: ['deathstreak'], text: 'You have died several rounds in a row, change your timing, peek earlier or later, they have your pattern read.', weight: 3 },
  { situations: ['deathstreak'], text: 'Dying first means you are taking first contact alone, wait for a teammate in trade range before you peek.', weight: 3 },
  { situations: ['deathstreak'], text: 'Reset the tilt, play one simple round with your team, no hero plays, just trades and discipline.', weight: 2 },
  { situations: ['winstreak'], text: 'Keep the same pace on a win streak, streaks end on overconfident dry peeks, stay disciplined.', weight: 2 },
  { situations: ['winstreak'], text: 'A losing team forces or rushes out of impatience, hold your discipline and punish the desperation.', weight: 1 },
  { situations: ['clutch'], text: 'In a clutch isolate one fight at a time, you cannot beat three at once but you can win three separate duels.', weight: 2 },
  { phase: 'dead', text: 'While dead, spectate for info and call setups and rotations, and note what killed you for next round.', weight: 2 },

  // ── roles (apply once the confirmed agent maps to a role) ───────────────
  { roles: ['duelist'], side: 'attack', text: 'Your entry creates space even when traded, but swing WITH your util as it lands, never before it.', weight: 2 },
  { roles: ['duelist'], text: 'Entry means in first, not in alone, check your team is actually moving behind you before you commit.', weight: 2 },
  { roles: ['controller'], side: 'attack', text: 'Smoke the crossing sightlines that stop your team walking in, not random doors, cut what actually kills.', weight: 2 },
  { roles: ['controller'], text: 'Time smokes with the hit, a smoke blooming as you enter beats one thrown a minute early.', weight: 2 },
  { roles: ['controller'], text: 'Keep one smoke in reserve for the post plant or retake, an empty controller loses late rounds.', weight: 2 },
  { roles: ['initiator'], text: 'Recon before the swing and act on your own info within seconds, scans expire fast.', weight: 2 },
  { roles: ['initiator'], text: 'Flash for your teammate swing, not your own peek, a flash nobody swings on is wasted util.', weight: 2 },
  { roles: ['sentinel'], side: 'attack', text: 'The moment your team commits to a site, set your utility watching the flank, that is your job before your gun.', weight: 2 },
  { roles: ['sentinel'], side: 'defense', text: 'Place trips and alarms where they buy you time, not in the first doorway everyone clears for free.', weight: 2 },
  { roles: ['sentinel'], side: 'defense', text: 'Anchor discipline, stay alive holding your site until help arrives, dying early hands the site over free.', weight: 2 },

  // ── agent specific (served only after the player confirms the agent) ────
  { agents: ['Jett'], text: 'Dash is your exit ticket, take the aggressive off angle only while dash is up, play passive without it.', weight: 2 },
  { agents: ['Jett'], text: 'An updraft peek works once, the second one gets pre aimed, use it somewhere different.', weight: 1 },
  { agents: ['Reyna'], text: 'Your kit only works off the opening pick, take the first duel with a trade or flash, then dismiss out.', weight: 2 },
  { agents: ['Omen'], text: 'Teleport behind your own smoke for the unexpected angle, and re smoke the choke as fights reset.', weight: 2 },
  { agents: ['Raze'], text: 'Send the boombot first to pull attention, then satchel or swing in behind it, never enter dry.', weight: 2 },
  { agents: ['Sage'], text: 'Wall to slow the push or split the site in half, and save resurrection for a player in a winning position.', weight: 2 },
  { agents: ['Killjoy'], text: 'A setup that got kills will get cleared next round, move your turret and swarms every round or two.', weight: 2 },
  { agents: ['Cypher'], text: 'Rotate your trip spots between rounds, a spotted setup is a dead setup, and recam after every fight.', weight: 2 },
  { agents: ['Viper'], text: 'Your molly on the spike wins post plants, hold it until the defuse actually starts.', weight: 2 },
  { agents: ['Clove'], text: 'You smoke from anywhere including while dead, keep smoking for your team every fight, that is your value.', weight: 2 },

  // ── map specific ────────────────────────────────────────────────────────
  { maps: ['Ascent'], text: 'Mid control decides Ascent, cat and market open both sites, fight for mid with util every round.', weight: 2 },
  { maps: ['Ascent'], text: 'Use the site doors on Ascent, closing a door mid execute splits their team and buys the retake.', weight: 1 },
  { maps: ['Haven'], text: 'Three sites make Haven rotations slow, call contact early on defense and fake one site to pull the rotate on attack.', weight: 2 },
  { maps: ['Bind'], text: 'No mid on Bind means teleporters decide rotations, listen for the TP audio and punish predictable takes.', weight: 2 },
  { maps: ['Split'], text: 'Mid control feeds both Split sites through vents and mail, take or deny mid before committing anywhere.', weight: 2 },
  { maps: ['Lotus'], text: 'The rotating doors on Lotus give away every rotation, keep one watched or tripped and use their audio for your own timing.', weight: 2 },
  { maps: ['Icebox'], text: 'Icebox is vertical, clear high angles first and only take ziplines when someone covers the ride.', weight: 2 },
  { maps: ['Breeze'], text: 'Breeze sightlines are long, rifles and Operators rule, do not force close range buys on gun rounds.', weight: 2 },
  { maps: ['Pearl'], text: 'Mid control on Pearl opens both sites and the flanks, do not let them own mid for free.', weight: 1 },
];

// Optional growth file: knowledge extracted from videos and VODs merges here.
let EXTRA = [];
try {
  const p = path.join(__dirname, '..', 'data', 'playbook.json');
  if (fs.existsSync(p)) {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(parsed)) EXTRA = parsed.filter((n) => n && typeof n.text === 'string');
    console.log('[knowledge] merged', EXTRA.length, 'playbook notes from data/playbook.json');
  }
} catch (e) {
  console.error('[knowledge] playbook.json ignored:', e.message);
}

const ALL = PLAYBOOK.concat(EXTRA);

// Agent -> role, so role notes fire off the confirmed agent.
const ROLE_OF = {
  jett: 'duelist', reyna: 'duelist', phoenix: 'duelist', raze: 'duelist',
  neon: 'duelist', yoru: 'duelist', iso: 'duelist', waylay: 'duelist',
  omen: 'controller', brimstone: 'controller', viper: 'controller',
  astra: 'controller', harbor: 'controller', clove: 'controller',
  sova: 'initiator', breach: 'initiator', skye: 'initiator', 'kay/o': 'initiator',
  fade: 'initiator', gekko: 'initiator', tejo: 'initiator',
  sage: 'sentinel', killjoy: 'sentinel', cypher: 'sentinel',
  chamber: 'sentinel', deadlock: 'sentinel', vyse: 'sentinel',
};

/** Read the live context into the flags the notes are tagged with. */
function situationOf(ctx) {
  const phaseRaw = String(ctx.phase || '').toLowerCase();
  const phase = phaseRaw.includes('buy') ? 'buy'
    : (phaseRaw.includes('plant') || phaseRaw.includes('post')) ? 'postplant'
    : phaseRaw === 'dead' ? 'dead'
    : 'active';

  const side = String(ctx.side || '').toLowerCase();
  const sideKey = side.includes('att') ? 'attack' : side.includes('def') ? 'defense' : null;

  const round   = Number(ctx.roundNumber) || 0;
  const credits = ctx.playerCredits == null ? null : Number(ctx.playerCredits);
  const flags   = new Set();
  if (round === 1 || round === 13) flags.add('pistol');
  if (phase === 'buy' && credits != null && !flags.has('pistol')) {
    if (credits < 2000) flags.add('eco');
    else if (credits < 3900) flags.add('forcebuy');
    else flags.add('fullbuy');
  }
  if ((Number(ctx.consecutiveDeaths) || 0) >= 2) flags.add('deathstreak');
  if ((Number(ctx.consecutiveWins)   || 0) >= 2) flags.add('winstreak');
  if (sideKey === 'defense' && phase === 'postplant') flags.add('retake');
  if (round > 0 && round <= 3) flags.add('early');

  const agent = typeof ctx.agent === 'string' && ctx.agent ? ctx.agent : null;
  const role  = agent ? ROLE_OF[agent.toLowerCase()] || null : null;
  const map   = typeof ctx.map === 'string' && ctx.map ? ctx.map.toLowerCase() : null;

  return { phase, side: sideKey, flags, agent, role, map };
}

/**
 * Retrieve the most relevant playbook notes for this exact situation.
 * Contradicting notes (wrong side, wrong phase, another agent's note) are
 * excluded outright; the rest are scored by how specifically they match.
 */
function retrieve(ctx, limit = 7) {
  const s = situationOf(ctx || {});
  const scored = [];

  for (const note of ALL) {
    // Exclusions: a tagged note never fires outside its tags.
    if (note.side  && s.side  && note.side  !== s.side)  continue;
    if (note.side  && !s.side) continue;                     // side unknown: skip side notes
    if (note.phase && note.phase !== s.phase) continue;
    if (note.agents && (!s.agent || !note.agents.some((a) => a.toLowerCase() === s.agent.toLowerCase()))) continue;
    if (note.roles  && (!s.role  || !note.roles.includes(s.role))) continue;
    if (note.maps   && (!s.map   || !note.maps.some((m) => m.toLowerCase() === s.map))) continue;
    if (note.situations && !note.situations.some((f) => s.flags.has(f))) continue;

    // Score: specificity of the match, plus base weight, plus a tiny jitter so
    // near ties rotate between requests instead of always serving one order.
    let score = note.weight || 1;
    if (note.agents) score += 4;
    if (note.maps)   score += 3;
    if (note.situations) score += 2 * note.situations.filter((f) => s.flags.has(f)).length;
    if (note.side)   score += 2;
    if (note.phase)  score += 2;
    if (note.roles)  score += 2;
    score += Math.random() * 0.8;

    scored.push({ text: note.text, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((n) => n.text);
}

/** The prompt block /analyze injects in place of the static habits list. */
function block(ctx, limit) {
  const notes = retrieve(ctx, limit);
  if (!notes.length) return '';
  return 'PRO PLAYBOOK (proven Radiant and pro habits retrieved for THIS exact situation, ground your tip in these before anything generic):\n'
    + notes.map((t) => '- ' + t).join('\n');
}

module.exports = { retrieve, block, situationOf, size: () => ALL.length };
