'use strict';
const express  = require('express');
const supabase = require('../db/supabase');
const router = express.Router();

// ─── Cost tracking (in-memory, resets on server restart) ──────────────────────
const costStore   = new Map();
const globalStats = { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '' };
const COST_PER_CALL = (1200 * 0.0000005) + (50 * 0.000003); // ~$0.00075

function trackCall(key) {
  const today = new Date().toISOString().slice(0, 10);
  if (globalStats.date !== today) {
    globalStats.callsToday = 0;
    globalStats.costToday  = 0;
    globalStats.date = today;
  }
  globalStats.callsToday++;
  globalStats.callsMonth++;
  globalStats.costToday  += COST_PER_CALL;
  globalStats.costMonth  += COST_PER_CALL;

  if (!costStore.has(key)) costStore.set(key, { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '' });
  const e = costStore.get(key);
  if (e.date !== today) { e.callsToday = 0; e.costToday = 0; e.date = today; }
  e.callsToday++;
  e.callsMonth++;
  e.costToday  += COST_PER_CALL;
  e.costMonth  += COST_PER_CALL;
}

function sanitize(t) {
  if (!t) return '';
  return t.replace(/\u2014/g, ', ').replace(/\u2013/g, ', ').replace(/ - /g, ', ').replace(/\s+/g, ' ').trim();
}

// ─── Direct Gemini REST call — tries primary model, falls back if 404 ─────────
const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-001', 'gemini-1.5-flash-latest'];

// Strict schema for /analyze responses — Gemini requires UPPERCASE type names
const ANALYZE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    tip: { type: 'STRING' },
    context: {
      type: 'OBJECT',
      properties: {
        agent:         { type: 'STRING',  nullable: true },
        map:           { type: 'STRING',  nullable: true },
        side:          { type: 'STRING',  nullable: true },
        roundNumber:   { type: 'INTEGER', nullable: true },
        teamScore:     { type: 'INTEGER', nullable: true },
        enemyScore:    { type: 'INTEGER', nullable: true },
        phase:         { type: 'STRING',  nullable: true },
        playerCredits: { type: 'INTEGER', nullable: true },
        playerAlive:   { type: 'BOOLEAN', nullable: true },
      },
    },
  },
  required: ['tip'],
};

async function geminiCall(imageB64, prompt, maxTokens, jsonMode) {
  const apiKey = process.env.GEMINI_API_KEY;
  const generationConfig = { maxOutputTokens: maxTokens || 100, temperature: 0.7 };
  if (jsonMode) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema   = ANALYZE_SCHEMA;
  }

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/jpeg', data: imageB64 } },
      ],
    }],
    generationConfig,
  });

  let lastError;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log('[coach] Calling Gemini model:', model, 'URL:', url.replace(apiKey, '***'));
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (response.status === 404) {
        console.warn(`[coach] Model ${model} returned 404, trying next...`);
        lastError = new Error(`404 for model ${model}`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[coach] Gemini API error (${response.status}):`, errorText.slice(0, 200));
        throw new Error(`Gemini ${response.status}`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return jsonMode ? text : sanitize(text);
    } catch (err) {
      if (err.message.startsWith('404 for model')) { lastError = err; continue; }
      throw err;
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

// ─── Text-only Gemini call (for match summary) ────────────────────────────────
async function geminiTextCall(prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;

  let lastError;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log('[coach] Calling Gemini model (text):', model);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens || 600, temperature: 0.5 },
        }),
      });

      if (response.status === 404) {
        lastError = new Error(`404 for model ${model}`);
        continue;
      }
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[coach] Gemini text error (${response.status}):`, errorText.slice(0, 200));
        throw new Error(`Gemini ${response.status}`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return sanitize(text);
    } catch (err) {
      if (err.message.startsWith('404 for model')) { lastError = err; continue; }
      throw err;
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

function buildContextPrompt(context) {
  const ctx = context || {};
  const recent = (ctx.lastTipsGiven || []).map((t, i) => `  ${i + 1}. ${t}`).join('\n') || '  None yet';

  const agentLine = ctx.agent
    ? `PLAYER AGENT (LOCKED, confirmed earlier in match): ${ctx.agent}. ALWAYS use this. Do not change.`
    : `PLAYER AGENT: Not yet identified. Look at bottom-center ability icons.`;

  return `You are a Radiant-level Valorant coach watching a live match. You have memory of the match so far.

${agentLine}

HOW TO IDENTIFY THE PLAYER (CRITICAL):

The PLAYER is the person whose perspective the screenshot is from. To identify their agent, look ONLY at these locations:

1. ABILITY ICONS at the BOTTOM-CENTER of the screen. The player has 4 ability icons in a row, just above their HP/shield bar. These are THE PLAYER'S abilities. Count the icons and match them to an agent.
2. The player's AGENT PORTRAIT in the BOTTOM-LEFT corner (small circle showing the agent's face).
3. The first-person view itself: if you can see hands, weapons, or first-person perspective, those are the player's.

DO NOT identify the agent from:
- The scoreboard at the top of the screen (those are all 10 players).
- The kill feed in the top-right (those are recent kills involving anyone).
- The minimap in the top-left (those dots are teammates).
- Any teammate's agent portrait visible in the team panel.
- Spectator views if the player is dead (in that case, focus on what the player did wrong before dying, not the spectated agent's gameplay).

THE PLAYER'S AGENT = the agent whose 4 abilities are shown at the bottom-center. NOTHING ELSE.

If you cannot clearly see the bottom-center ability bar, set agent to null and give general advice that does not mention any specific abilities.

CRITICAL: Before suggesting any agent-specific ability, verify by checking the bottom-center ability icons. If the icons show smokes and a dash, the player is Jett (or possibly Omen depending on which smokes). If the icons show a knife, traps, and a camera, the player is Cypher. Match the EXACT icons to the EXACT agent. If the screenshot is a death/spectator screen and the player's ability bar is not visible, do NOT guess the agent — give general death advice without naming abilities.

TIP FRAMING RULES:
- When advising the player to use their own abilities: "Use your X" or "Your X can clear this corner".
- When advising about a teammate's ability: "Ask your [Agent] teammate to X" or "Your [Agent] teammate's X would be useful here".
- If you mention an agent name, ALWAYS specify if it is "your" agent (the player's) or "your teammate's" agent.
- If you are not sure who has which agent, give general advice without agent names.

NEVER suggest an ability unless you are 100 percent certain the player has it. When in doubt, give general advice (positioning, economy, crosshair placement) instead of agent-specific advice. Better to be vague than wrong.

COMPLETE AGENT ABILITY LIST (memorize):
- Jett: Cloudburst (smoke), Updraft (jump), Tailwind (dash), Blade Storm (knife ult). NO walls. NO flashes. NO traps.
- Reyna: Leer (blind eye), Devour (heal), Dismiss (escape), Empress (ult). NO smokes. NO walls.
- Phoenix: Curveball (flash), Hot Hands (molly), Blaze (fire wall), Run It Back (respawn ult).
- Raze: Boom Bot, Blast Pack (satchel), Paint Shells (nade), Showstopper (rocket ult).
- Neon: Fast Lane (walls), Relay Bolt (stun), High Gear (sprint), Overdrive (beam ult).
- Iso: Undercut (debuff), Double Tap (shield), Contingency (wall), Kill Contract (ult).
- Yoru: Fakeout (decoy), Blindside (flash), Gatecrash (teleport), Dimensional Drift (ult).
- Sova: Owl Drone, Shock Bolt, Recon Bolt, Hunter's Fury (wallbang ult).
- Breach: Flashpoint, Fault Line (stun), Aftershock, Rolling Thunder (ult).
- Skye: Trailblazer (dog), Guiding Light (flash bird), Regrowth (heal), Seekers (ult).
- KAY/O: FLASH/drive, ZERO/point (suppress knife), FRAG/ment (molly), NULL/cmd (suppress ult).
- Fade: Prowler, Seize (tether), Haunt (eye), Nightfall (ult).
- Gekko: Wingman, Dizzy, Mosh Pit, Thrash (ult).
- Tejo: only mention abilities if visible on screen.
- Omen: Shrouded Step (teleport), Paranoia (blind), Dark Cover (smokes), From The Shadows (ult).
- Brimstone: Stim Beacon, Incendiary (molly), Sky Smoke (smokes), Orbital Strike (ult).
- Viper: Snake Bite (molly), Poison Cloud (smoke orb), Toxic Screen (wall), Viper's Pit (ult).
- Astra: Gravity Well, Nova Pulse, Nebula (smoke), Cosmic Divide (ult).
- Harbor: Cove (bubble), High Tide (water wall), Cascade, Reckoning (ult).
- Clove: Pick-Me-Up, Meddle, Ruse (smokes can cast dead), Not Dead Yet (self-revive ult).
- Sage: Slow Orb, Healing Orb, Barrier (wall), Resurrection (ult).
- Killjoy: Nanoswarm, Alarmbot, Turret, Lockdown (ult).
- Cypher: Trapwire, Cyber Cage (smoke), Spycam, Neural Theft (ult).
- Chamber: Trademark (slow trap), Headhunter (sheriff), Rendezvous (teleport), Tour De Force (op ult).
- Deadlock: GravNet, Sonic Sensor, Barrier Mesh (wall), Annihilation (ult).
- Vyse: Arc Rose, Shear, Razorvine, Steel Garden.
- Waylay: only mention abilities if visible on screen.

If you cannot see all 4 ability icons clearly, give general advice instead of agent-specific advice.

CURRENT MATCH STATE (carry this forward, do not re-detect from scratch every frame):
- Agent: ${ctx.agent || 'Unknown'}
- Map: ${ctx.map || 'Unknown'}
- Side: ${ctx.side || 'Unknown'}
- Round: ${ctx.roundNumber || 'Unknown'}
- Score: ${ctx.teamScore || 0} to ${ctx.enemyScore || 0}
- Phase: ${ctx.phase || 'Unknown'}
- Player credits: ${ctx.playerCredits == null ? 'Unknown' : ctx.playerCredits}
- Player alive: ${ctx.playerAlive === false ? 'No' : 'Yes'}
- Consecutive deaths: ${ctx.consecutiveDeaths || 0}
- Recent tips you gave (do NOT repeat or rephrase these):
${recent}

YOUR TASK:
Analyze the screenshot and give ONE specific coaching tip if there is something useful to say. Otherwise respond with SKIP.

AGENT KNOWLEDGE (only suggest abilities the player's agent actually has):
- Jett: Cloudburst smoke, Updraft jump, Tailwind dash, Blade Storm ult. NO walls, NO flashes.
- Reyna: Leer blind eye, Devour heal, Dismiss escape, Empress ult. NO smokes.
- Phoenix: Curveball flash, Hot Hands molly, Blaze fire wall, Run It Back ult.
- Raze: Boom Bot, Blast Pack satchel, Paint Shells nade, Showstopper rocket.
- Sova: Owl Drone, Shock Bolt, Recon Bolt, Hunter's Fury wallbang.
- Omen: Shrouded Step teleport, Paranoia blind, Dark Cover smokes, From The Shadows.
- Brimstone: Stim Beacon, Incendiary molly, Sky Smoke, Orbital Strike ult.
- Viper: Snake Bite molly, Poison Cloud, Toxic Screen wall, Viper's Pit ult.
- Killjoy: Nanoswarm, Alarmbot, Turret, Lockdown ult.
- Sage: Slow Orb, Healing Orb, Barrier wall, Resurrection ult.
- Cypher: Trapwire, Cyber Cage, Spycam, Neural Theft.
- Chamber: Trademark trap, Headhunter pistol, Rendezvous teleport, Tour De Force op.
- Skye: Trailblazer dog, Guiding Light flash bird, Regrowth heal, Seekers ult.
- KAY/O: FLASH/drive, ZERO/point knife, FRAG/ment molly, NULL/cmd suppress ult.
- Breach: Flashpoint, Fault Line stun, Aftershock, Rolling Thunder ult.
- Astra: Gravity Well, Nova Pulse, Nebula smoke, Cosmic Divide wall.
- Yoru: Fakeout, Blindside flash, Gatecrash teleport, Dimensional Drift.
- Fade: Prowler, Seize tether, Haunt eye, Nightfall ult.
- Gekko: Wingman, Dizzy, Mosh Pit, Thrash ult.
- Neon: Fast Lane walls, Relay Bolt stun, High Gear sprint, Overdrive beam.
- Harbor: Cove bubble, High Tide wall, Cascade wave, Reckoning ult.
- Iso: Undercut, Double Tap shield, Contingency wall, Kill Contract.
- Deadlock: GravNet, Sonic Sensor, Barrier Mesh, Annihilation ult.
- Clove: Pick-Me-Up, Meddle, Ruse smokes (can cast dead), Not Dead Yet.
- Vyse: Arc Rose, Shear, Razorvine, Steel Garden.
- Tejo / Waylay / others: only reference abilities visibly shown on screen, do not invent.

ECONOMY RULES:
- Round 1 or 13 (pistol): only Ghost or light shields plus abilities.
- Under 2000 credits: full save.
- 2000 to 3900: force buy Spectre with light shields.
- 3900+: full buy Vandal or Phantom with full shields and abilities.
- If team is saving, save with them.

WHEN TO STAY SILENT (respond with SKIP):
- Player is just walking with nothing notable happening.
- Nothing visible has changed since the last tip.
- You would just repeat what you already said.
- The screen shows a menu, lobby, agent select, or loading screen.
- You cannot identify a specific actionable tip.

WHEN TO GIVE A TIP:
- Buy phase: economy advice based on visible credits.
- Player is in bad position: suggest reposition.
- Player just died: explain what happened.
- Spike planted: post-plant or retake advice.
- Player has utility unused that should be used.
- Player about to make obvious mistake.

RESPONSE FORMAT (return valid JSON, nothing else):
{
  "tip": "Your coaching tip in 8 to 20 words ending with a period. OR the word SKIP if nothing useful to say.",
  "context": {
    "agent": "detected agent name or null",
    "map": "detected map name or null",
    "side": "Attack or Defense or null",
    "roundNumber": detected round number or null,
    "teamScore": detected team score or null,
    "enemyScore": detected enemy score or null,
    "phase": "buy or active or postplant or dead or menu",
    "playerCredits": detected credits number or null,
    "playerAlive": true or false
  }
}

CRITICAL RULES:
- Tip MUST be a complete sentence ending in a period.
- Tip MUST be 8 to 20 words.
- Never use em-dashes or long dashes. Use commas and periods.
- Never suggest abilities the player's agent does not have.
- Never repeat tips from the recent tips list above.
- When in doubt, respond with SKIP. Quality over quantity.
- Always return valid JSON.

TIP LENGTH RULES (STRICT):
- Maximum 14 words. NEVER more than 14 words.
- Minimum 6 words.
- Must be a complete sentence ending with a period.
- Be concise. A real coach speaks in short, punchy commands.

Bad (too long): "Consider how Breach might have used his utility to initiate that engagement and adapt your positioning."
Good (concise): "Your Breach should flash, then you push the angle."

Bad (too long): "After dying, analyze how Clove's abilities might have helped you survive that engagement."
Good (concise): "Your Clove can smoke before you peek next time."

If you cannot fit your thought in 14 words, simplify the advice.

CRITICAL TIP REQUIREMENTS: Never end with conjunctions (and, or, but), prepositions (to, with, for, of, in, at), articles (the, a, an), or possessives (Jett's, the player's, your). Always finish your thought before the period.

COMPLETE-SENTENCE RULE: If your tip mentions an ability, name it specifically.
- BAD: "Use Jett's." (incomplete — Jett's what?)
- BAD: "You should rotate to the." (truncated)
- BAD: "Push hard and." (ends with conjunction)
- GOOD: "Use Jett's Tailwind dash to escape after that kill."
- GOOD: "Rotate A through spawn before the timer ends."

WHEN TO SKIP vs GIVE A TIP:
SKIP only in these specific cases:
- The screenshot shows a main menu, agent select, lobby, or loading screen.
- You literally cannot see any Valorant gameplay.
- The screen is mostly black or unreadable.

ALWAYS give a tip when you see gameplay, even if nothing dramatic is happening. There is always something useful to say:
- During buy phase: economy advice based on visible credits.
- During active round: positioning, crosshair, utility usage.
- Post-plant: time management, retake setup.
- Death screen: what could have been done differently.

Do not be overly conservative. The player WANTS feedback. If you see a Valorant match, give actionable advice. SKIP should be rare, only for non-gameplay screens.`;
}

const SMART_PROMPT = `You are a Radiant-level Valorant coach analyzing a live gameplay screenshot. Give one coaching tip that is 8 to 20 words long. Your tip must be a complete, specific, actionable sentence.

LOOK AT THE SCREENSHOT CAREFULLY. Read the HUD elements:
- Top of screen: round score, round timer, player icons showing alive/dead
- Bottom of screen: current weapon, ability charges, credits (during buy phase)
- Minimap: player positions, spike location
- Center: crosshair placement, what angle the player is holding
- Kill feed: recent kills and deaths

ECONOMY RULES (very important):
- Round 1 or 13 (pistol round): Players have 800 credits. Can only buy Ghost (500) + light shields (400) or abilities. NEVER suggest Vandal, Phantom, Spectre, or full shields.
- Under 2000 credits: Full save or buy Sheriff only. Say "Full save this round, do not buy anything."
- 2000-3900 credits: Force buy with Spectre (1600) + light shields. Say "Force buy Spectre with light shields."
- 3900+ credits: Full buy. Say "Full buy, get Vandal or Phantom with full shields."
- After winning pistol (round 2 or 14): Buy Spectre + full shields.
- After losing pistol (round 2 or 14): Full save, buy nothing.
- If most teammates are saving (no weapons visible), save too.

POSITIONING TIPS:
- "Off-angle the entrance, do not stand in the default spot."
- "You are exposed to two angles, back up to cover one."
- "Hold closer to the wall for a tighter angle."
- "After that kill, reposition. Do not repeek the same spot."
- "Play retake this round, do not hold site alone."
- "Rotate through spawn, going through mid is risky alone."
- "Stack with your teammate for a crossfire setup."

UTILITY TIPS:
- "Use your smoke before your team peeks that angle."
- "Save your flash for the site execute, do not waste it."
- "Drone or recon before pushing, do not dry peek."
- "Molly the default plant spot to deny spike plant."
- "Wall off the flank so your team can push safely."

COMBAT TIPS:
- "Aim at head level, your crosshair is too low."
- "Stop wide swinging, jiggle peek to get info first."
- "Let your teammate go first and trade if they die."
- "You are low health, play passive and let others peek."
- "Spike is planted, play time. Do not push, let them come."

DEATH TIPS (when the player is dead or spectating):
- "You peeked without using any utility, flash or smoke first next time."
- "You were holding a common angle, try an off-angle instead."
- "Check minimap before pushing, a teammate already died there."
- "You took a 1v1 duel you did not need to take, play with your team."

RULES:
- Always give a complete sentence between 8 and 20 words.
- Be specific to what you see in the screenshot.
- Reference visible information: round number, credits, weapons, map positions.
- Do not use em-dashes or long dashes. Use commas and periods only.
- Do not give generic advice. Every tip should reference something visible on screen.
- If you see a main menu, lobby, or agent select screen, respond with only "SKIP".
- Ignore any small overlay UI elements in the corners of the screenshot. Focus only on the Valorant gameplay.

AGENT-SPECIFIC ABILITY KNOWLEDGE:
Look at the bottom-right of the screen to identify which agent the player is using by their ability icons. Give tips that reference ONLY that agent's actual abilities. Never suggest an ability the agent does not have.

DUELISTS:
- Jett: Cloudburst (smokes), Updraft (jump), Tailwind (dash), Blade Storm (knives ultimate). "Use Jett smokes to cross safely." "Dash out after getting a kill." "Updraft to reach an off-angle." Never say Jett has a wall or flash.
- Reyna: Leer (blind eye), Devour (heal from soul), Dismiss (invulnerable escape), Empress (ultimate). "Throw Leer before peeking to blind them." "Devour that soul orb to heal up." "Dismiss out after getting the kill." Never say Reyna has smokes.
- Phoenix: Blaze (fire wall), Curveball (flash), Hot Hands (molly), Run It Back (ultimate respawn). "Flash before peeking that corner." "Wall off their vision with Blaze." "Molly the corner to clear it."
- Raze: Boom Bot (robot), Blast Pack (satchel), Paint Shells (grenade), Showstopper (rocket ultimate). "Boom Bot that corner before pushing." "Satchel up for a height advantage." "Nade the grouped enemies."
- Neon: Fast Lane (walls), Relay Bolt (stun), High Gear (sprint), Overdrive (ultimate beam). "Sprint through with Fast Lane walls up." "Stun them with Relay Bolt before entry."
- Iso: Undercut (debuff), Double Tap (shield), Contingency (wall), Kill Contract (ultimate). "Use Double Tap before peeking for the shield." "Undercut through the wall to debuff them."
- Yoru: Fakeout (decoy), Blindside (flash), Gatecrash (teleport), Dimensional Drift (ultimate). "Teleport behind them with Gatecrash." "Flash before peeking." "Use decoy to bait them."

INITIATORS:
- Sova: Owl Drone (drone), Shock Bolt (damage arrow), Recon Bolt (scan arrow), Hunter's Fury (ultimate wallbang). "Recon the site before your team pushes." "Drone to check if they are holding." "Shock bolt the default plant spot."
- Breach: Flashpoint (flash), Fault Line (stun), Aftershock (damage through wall), Rolling Thunder (ultimate stun). "Flash through the wall for your team." "Stun them before your team peeks."
- Skye: Trailblazer (dog), Guiding Light (flash bird), Regrowth (heal), Seekers (ultimate). "Flash with the bird before peeking." "Dog that corner to clear it." "Heal your team during buy phase."
- KAY/O: FLASH/drive (flash), ZERO/point (suppress knife), FRAG/ment (molly), NULL/cmd (ultimate suppress). "Knife the site to suppress their abilities." "Flash then peek immediately." "Molly the corner to clear it."
- Fade: Prowler (chase creature), Seize (tether), Haunt (reveal eye), Nightfall (ultimate). "Haunt the site to reveal enemies before pushing." "Prowler to chase them out of corners."
- Gekko: Wingman (plant/defuse creature), Dizzy (blind), Mosh Pit (grenade), Thrash (ultimate stun). "Send Dizzy to blind before pushing." "Wingman can plant the spike for you." "Mosh pit the area to clear it."

CONTROLLERS:
- Omen: Shrouded Step (teleport), Paranoia (blind), Dark Cover (smokes), From The Shadows (ultimate teleport). "Smoke the choke point before your team pushes." "Paranoia through the wall to blind them." "Teleport to an off-angle with Shrouded Step."
- Brimstone: Stim Beacon (speed boost), Incendiary (molly), Sky Smoke (smokes), Orbital Strike (ultimate). "Smoke A main and A short for the execute." "Molly the default plant to deny defuse." "Stim your team before pushing."
- Viper: Snake Bite (molly), Poison Cloud (smoke orb), Toxic Screen (wall), Viper's Pit (ultimate). "Put your wall up for the execute." "Snake bite the corner to force them out." "Your smoke is rechargeable, use it aggressively."
- Astra: Gravity Well (pull), Nova Pulse (stun), Nebula (smoke), Cosmic Divide (ultimate wall). "Smoke the entry, then pull them out of position." "Stun the site before your team enters."
- Harbor: Cove (bubble shield), High Tide (water wall), Cascade (water wave), Reckoning (ultimate). "Wall off their angles with High Tide." "Cove the spike plant for protection."
- Clove: Pick-Me-Up (self revive buff), Meddle (decay), Ruse (smokes, can cast while dead), Not Dead Yet (ultimate self revive). "You can smoke even after dying, use Ruse." "Meddle them before your team peeks."

SENTINELS:
- Sage: Barrier Orb (wall), Slow Orb (slow), Healing Orb (heal), Resurrection (ultimate revive). "Wall off the push to slow them down." "Heal your teammate, they are low." "Slow the entrance to delay the rush." "You have rez, save it for a key teammate."
- Killjoy: Nanoswarm (grenade trap), Alarmbot (detect bot), Turret (auto turret), Lockdown (ultimate). "Place turret watching flank." "Save your nanoswarm for when they push." "Lockdown the site to delay the execute."
- Cypher: Trapwire (trip wire), Cyber Cage (smoke cage), Spycam (camera), Neural Theft (ultimate). "Camera the site to watch for pushes." "Tripwire the flank entrance." "Cage and peek when they trigger the trap."
- Chamber: Trademark (slow trap), Headhunter (sheriff ability), Rendezvous (teleport), Tour De Force (operator ultimate). "Teleport anchor set up for escape." "Use Headhunter for the eco round." "Place your trap watching the flank."
- Deadlock: GravNet (slow net), Sonic Sensor (sound trap), Barrier Mesh (wall), Annihilation (ultimate). "Sonic sensor the entrance to detect pushes." "GravNet them if they rush."

CRITICAL RULES FOR ABILITIES:
- If you see ability charges at 0 or grayed out at the bottom of the screen, the player has USED that ability already. Do not suggest using an ability that is already spent.
- If the ultimate meter is not full (not glowing or shows a number less than max), do not suggest using ultimate.
- NEVER suggest an ability that belongs to a different agent.
- Identify the agent from the ability icons at the bottom of the screen. Each agent has a unique set of 4 ability icons.

AGENT IDENTIFICATION RULE:
IMPORTANT: To identify the player's agent, look at the bottom-center of the screen where the ability icons are. Each agent has unique ability icons. If you cannot clearly identify the agent, give general tips instead of agent-specific ones. NEVER guess which agent the player is. If you are not 100 percent certain of the agent, do not mention any specific abilities. Just give general positioning or economy advice instead.

MATCH END DETECTION:
If you see a VICTORY or DEFEAT end-of-match screen, respond with only the word VICTORY or DEFEAT. No other text.

CRITICAL: Always finish your sentence. Every tip must end with a period. Never leave a tip incomplete or trailing off. If you cannot fit your thought in 20 words, shorten it, but always complete the sentence with a period.

IMPORTANT: Only give a tip if you see something specific worth commenting on. If the player is just walking, holding an angle normally, or nothing notable is happening, respond with SKIP. Do not give tips just to give tips. Quality matters more than quantity. A real coach speaks up when they see a mistake or an opportunity, not every 30 seconds. If you would not interrupt a player in a real match to say it, respond with SKIP instead.

WHEN TO GIVE A TIP vs WHEN TO STAY SILENT:

GIVE a tip when you see:
- Buy phase: give economy advice based on credits visible.
- The player is holding a bad angle or position: suggest a better spot.
- The player is alone and should be with team: tell them to group up.
- Post-plant situation: give post-plant advice.
- Spike is being planted on defense: give retake advice.
- The player just died: analyze what went wrong from the death screen.
- The player is rotating: advise on rotation path.
- Pre-round positioning: suggest where to play.
- A teammate died nearby: suggest trading or falling back.
- Low health visible: tell them to play passive.

Stay SILENT (respond with "SKIP") when:
- The player is just walking and nothing interesting is happening.
- The player is in a normal position with nothing to correct.
- There is no specific advice that would help right now.
- The round just started and players are still positioning.

It is BETTER to say SKIP and give no tip than to give generic obvious advice. Only speak when you have something specific and useful to say based on what you SEE in the screenshot. Quality over quantity. If you cannot identify a specific mistake or opportunity, say SKIP.

CRITICAL RULE: Every tip must be a complete sentence that ends with a period. Never cut off mid-sentence. If your tip would be too long, shorten it but always finish the sentence. A tip like "You are exposed to two" is WRONG. A tip like "You are exposed to two angles, reposition to cover." is CORRECT.`;

const FORCED_PROMPT = SMART_PROMPT + `\n\nOVERRIDE: The player is manually requesting coaching advice right now. Look at the screenshot and give your best tip based on the current situation. Do not respond with SKIP. Always give advice when manually requested.`;

const ROUND_SUMMARY_PROMPT = 'You are analyzing a Valorant round that just ended. Return ONLY valid JSON, no markdown: {"round_result":"win","things_done_well":["praise under 12 words"],"things_to_improve":["advice under 12 words"],"key_tip_for_next_round":"tip under 12 words","performance_rating":3} round_result: win, loss, or unknown. 1-3 items per array. performance_rating 1-5. No em-dashes.';

const KEY_REGEX = /^GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

async function validateKey(k) {
  if (!k || !KEY_REGEX.test(k)) return false;
  const { data } = await supabase
    .from('licenses')
    .select('status,expires_at')
    .eq('license_key', k)
    .single();
  if (!data || data.status !== 'active') return false;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return false;
  return true;
}

// POST /api/coach/analyze  — JSON body: { image: base64, context: {...} }
router.post('/analyze', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();

  if (!licenseKey) return res.status(400).json({ error: 'X-License-Key header required' });
  if (!await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid or expired license key' });

  const image   = req.body && req.body.image;
  const context = (req.body && req.body.context) || {};
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'No image data' });

  const isForced = req.headers['x-forced'] === 'true';
  const prompt   = buildContextPrompt(context) + (isForced
    ? '\n\nOVERRIDE: The player manually requested coaching. Always give a real tip — do not respond with SKIP.'
    : '');

  const t0 = Date.now();
  try {
    const raw = await Promise.race([
      geminiCall(image, prompt, 250, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout')), 10000)),
    ]);
    trackCall(licenseKey);

    // Robust parse — NEVER throws. Falls back to plain-text-as-tip.
    let parsed = { tip: null, context: {} };
    const rawStr = String(raw).trim();
    console.log('[coach] Raw Gemini text:', rawStr.slice(0, 200));
    try {
      const cleaned   = rawStr.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = { tip: cleaned, context: {} };
      }
    } catch (e) {
      console.error('[coach] JSON parse failed, using as plain tip:', e.message);
      parsed = { tip: rawStr, context: {} };
    }

    // Unwrap double-encoded responses ({ tip: "{\"tip\":\"...\"}" })
    let finalTip = parsed.tip;
    if (typeof finalTip === 'object' && finalTip !== null) {
      finalTip = finalTip.tip || JSON.stringify(finalTip);
    }
    if (typeof finalTip !== 'string') finalTip = String(finalTip == null ? '' : finalTip);

    // If the tip itself is JSON-looking, try to peel one more layer
    const innerTrim = finalTip.trim();
    if (innerTrim.startsWith('{') && innerTrim.endsWith('}')) {
      try {
        const inner = JSON.parse(innerTrim);
        if (inner && typeof inner.tip === 'string') finalTip = inner.tip;
      } catch {}
    }

    // Strip any leftover JSON syntax fragments
    finalTip = finalTip
      .replace(/^[\s{]*"?tip"?\s*:\s*"?/i, '')  // leading {"tip": "
      .replace(/"?\s*[}]*\s*$/, '')             // trailing "}
      .trim();

    let tip    = sanitize(finalTip);
    let outCtx = parsed.context || {};
    console.log('[coach] Final tip:', tip.slice(0, 100));

    // Enforce complete sentence on the server before sending to client
    if (tip && tip !== 'SKIP' && tip !== 'VICTORY' && tip !== 'DEFEAT') {
      const lastChar = tip.charAt(tip.length - 1);
      if (lastChar !== '.' && lastChar !== '!' && lastChar !== '?') {
        if (tip.length > 30) {
          tip = tip + '.';
        } else {
          console.log('[coach] Discarded incomplete tip:', tip);
          tip = 'SKIP';
        }
      }
    }

    console.log('[coach] ' + licenseKey.slice(0, 8) + '... agent=' + (outCtx.agent || '?') +
      ' round=' + (outCtx.roundNumber || '?') + ' phase=' + (outCtx.phase || '?') +
      ' -> "' + (tip || '').slice(0, 60) + '" (' + (Date.now() - t0) + 'ms)');
    res.json({ tip: tip || '', context: outCtx });
  } catch (err) {
    console.error('[coach] analyze error:', err.message, err.stack && err.stack.split('\n')[1]);
    res.json({ tip: '', context: {} });
  }
});

// POST /api/coach/summary/round  — raw binary JPEG body
router.post('/summary/round', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No image data' });
  try {
    const text = await Promise.race([
      geminiCall(req.body.toString('base64'), ROUND_SUMMARY_PROMPT, 400),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
    trackCall(licenseKey);
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (err) {
    console.error('[coach] round summary error:', err.message);
    res.status(500).json({ error: 'Summary failed' });
  }
});

// POST /api/coach/summary/match  — JSON body: { tips: string[] }
router.post('/summary/match', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
  const tips = Array.isArray(req.body && req.body.tips) ? req.body.tips.slice(0, 30) : [];
  if (tips.length < 3) return res.status(400).json({ error: 'Not enough tips' });

  const sysPrompt = [
    'You are summarizing a Valorant coaching session. Tips given: ' + tips.join('. '),
    'Create a match performance summary as valid JSON only, no markdown:',
    '{"match_result":"unknown","overall_rating":5,"strengths":["string"],"weaknesses":["string"],"most_common_mistake":"string","biggest_improvement_tip":"string","highlight_moments":["string"]}',
    'overall_rating 1-10. match_result: victory, defeat, or unknown. No em-dashes. Under 15 words per item.',
  ].join('\n');

  try {
    const text = await Promise.race([
      geminiTextCall(sysPrompt, 600),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
    trackCall(licenseKey);
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (err) {
    console.error('[coach] match summary error:', err.message);
    res.status(500).json({ error: 'Summary failed' });
  }
});

// POST /api/coach/recap  — JSON body: { tips: string[] }
router.post('/recap', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
  const tips = Array.isArray(req.body && req.body.tips) ? req.body.tips.slice(0, 10) : [];
  if (tips.length === 0) return res.status(400).json({ error: 'No tips provided' });

  const prompt = `A Valorant round just ended. During this round, these coaching tips were given: ${tips.join('. ')}. Based on these tips, give a brief 2-sentence round recap. First sentence: one thing the player did well or tried to do. Second sentence: one thing to focus on next round. Keep each sentence under 15 words. Do not use dashes.`;

  try {
    const recap = await Promise.race([
      geminiTextCall(prompt, 100),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);
    trackCall(licenseKey);
    res.json({ recap: recap || '' });
  } catch (err) {
    console.error('[coach] recap error:', err.message);
    res.status(500).json({ error: 'Recap failed' });
  }
});

// GET /api/coach/player-stats?username=Name%23TAG
router.get('/player-stats', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

  const username = req.query.username;
  if (!username || !username.includes('#')) return res.json({ error: 'No username or missing # tag' });

  try {
    const [name, tag] = username.split('#');
    const url = `https://api.tracker.gg/api/v2/valorant/standard/profile/riot/${encodeURIComponent(name)}%23${encodeURIComponent(tag)}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'GhostCoach/1.0', 'TRN-Api-Key': process.env.TRACKER_API_KEY || '' }
    });

    if (!response.ok) return res.json({ error: 'Player not found' });

    const data = await response.json();
    const stats = data?.data?.segments?.[0]?.stats;

    res.json({
      rank:         stats?.rank?.metadata?.tierName || 'Unknown',
      kd:           stats?.kDRatio?.value           || 0,
      winRate:      stats?.matchesWinPct?.value      || 0,
      headshotPct:  stats?.headshotsPercentage?.value || 0,
      topAgent:     data?.data?.segments?.[1]?.metadata?.name || 'Unknown',
    });
  } catch (e) {
    console.error('[stats] Error:', e.message);
    res.json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/coach/match-review  — JSON body: { tips: string[] }
router.post('/match-review', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const tips = Array.isArray(req.body && req.body.tips) ? req.body.tips.slice(0, 30) : [];
    if (tips.length < 3) return res.json({ review: 'Not enough data for a review.' });

    const prompt = `Here are coaching tips from a Valorant match:\n${tips.join('\n')}\n\nWrite a 3-sentence match review. Sentence 1: what the player did well. Sentence 2: their most common mistake. Sentence 3: what to focus on next match. Do not use dashes. End each sentence with a period.`;

    const review = await Promise.race([
      geminiTextCall(prompt, 200),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
    trackCall(licenseKey);
    res.json({ review: review || 'Could not generate review.' });
  } catch (e) {
    console.error('[review] Error:', e.message);
    console.error(e.stack);
    res.json({ review: 'Review generation failed.' });
  }
});

// POST /api/coach/suggest-library-tip — JSON body: { context, availableTips: string[] }
router.post('/suggest-library-tip', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const context       = (req.body && req.body.context) || {};
    const availableTips = Array.isArray(req.body && req.body.availableTips) ? req.body.availableTips.slice(0, 30) : [];
    if (availableTips.length === 0) return res.json({ tip: null });

    const prompt = `You are a Valorant coach. Based on the current match state, pick the BEST tip from this list to show the player right now. Return ONLY the exact text of the chosen tip, nothing else.

Match state:
- Agent: ${context.agent || 'Unknown'}
- Round: ${context.roundNumber || 'Unknown'}
- Phase: ${context.phase || 'Unknown'}
- Score: ${context.teamScore || 0} to ${context.enemyScore || 0}
- Consecutive deaths: ${context.consecutiveDeaths || 0}
- Consecutive wins: ${context.consecutiveWins || 0}

Available tips:
${availableTips.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return only the exact tip text. No quotes, no formatting, no explanation.`;

    const text = await Promise.race([
      geminiTextCall(prompt, 100),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    trackCall(licenseKey);
    const tip = String(text || '').trim().replace(/^["']|["']$/g, '');
    res.json({ tip: tip || null });
  } catch (e) {
    console.error('[coach] suggest-library-tip error:', e.message);
    res.json({ tip: null });
  }
});

module.exports = router;
module.exports.costStore   = costStore;
module.exports.globalStats = globalStats;
