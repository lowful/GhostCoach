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

// ─── AI provider (OpenAI-compatible) ──────────────────────────────────────────
// Set AI_API_KEY to switch off Gemini onto ANY OpenAI-compatible endpoint
// (OpenRouter, Alibaba DashScope, OpenAI, Together, etc). Default target is
// OpenRouter + Qwen3-VL, which reads game HUDs well and is cheap. Until
// AI_API_KEY is set, the legacy Gemini path is used, so deploying changes nothing.
const AI = {
  provider:    (process.env.AI_PROVIDER || (process.env.AI_API_KEY ? 'openai' : 'gemini')).toLowerCase(),
  baseUrl:     (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  apiKey:      process.env.AI_API_KEY || '',
  visionModel: process.env.AI_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct',
  textModel:   process.env.AI_TEXT_MODEL   || process.env.AI_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct',
};

// One OpenAI-style chat call. `imageB64` present => multimodal (vision) request.
async function chatCall({ prompt, imageB64, maxTokens, temperature }) {
  const content = imageB64
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
      ]
    : prompt;

  const resp = await fetch(`${AI.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${AI.apiKey}`,
      'HTTP-Referer':  'https://ghostcoachai.com', // OpenRouter attribution (ignored elsewhere)
      'X-Title':       'GhostCoach',
    },
    body: JSON.stringify({
      model:       imageB64 ? AI.visionModel : AI.textModel,
      messages:    [{ role: 'user', content }],
      max_tokens:  maxTokens || 100,
      temperature: temperature == null ? 0.7 : temperature,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[coach] AI error (${resp.status}):`, text.slice(0, 200));
    throw new Error(`AI ${resp.status}`);
  }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// Unified entry points the routes call: dispatch to the configured provider.
async function visionInfer(imageB64, prompt, maxTokens, jsonMode) {
  if (AI.provider === 'gemini') return geminiCall(imageB64, prompt, maxTokens, jsonMode);
  const text = await chatCall({ imageB64, prompt, maxTokens, temperature: 0.7 });
  return jsonMode ? text : sanitize(text);
}
async function textInfer(prompt, maxTokens) {
  if (AI.provider === 'gemini') return geminiTextCall(prompt, maxTokens);
  return sanitize(await chatCall({ prompt, maxTokens, temperature: 0.5 }));
}

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
  const ctx        = context || {};
  const recentList = ctx.recentTips || ctx.lastTipsGiven || [];
  const recent     = recentList.length ? recentList.map((t, i) => (i + 1) + '. ' + t).join('\n') : '(none yet)';
  const topics     = (Array.isArray(ctx.recentTopics) && ctx.recentTopics.length) ? ctx.recentTopics.join(', ') : 'none yet';
  const buyClear   = ctx.buyInfoClear !== false;
  const buyNote    = buyClear ? '' : ' Right now credits or round are NOT clearly visible, so give a tactical tip, not a buy tip.';
  const focusLine  = ctx.focus ? ('This frame, lean toward: ' + ctx.focus + '.\n\n') : '';
  const side       = String(ctx.side || '').toLowerCase();

  const sideBlock = side.includes('att')
    ? `YOU ARE ON ATTACK. The goal is to take space with utility, trade your entries, and hit a site together, then win the post-plant.
Coach at a Radiant level: gather info before committing, use util to clear or take an angle BEFORE you peek, stay in trade range with a teammate, take map control on defaults instead of forcing, plant in a spot the team can protect, and save util for the post-plant. Catch and correct: dry peeks, wasted early util, lurking too deep with no impact, planting in the open, and solo plays with no trade.`
    : side.includes('def')
    ? `YOU ARE ON DEFENSE. The goal is to get early picks, hold with crossfires, gather info, delay with util, and retake as a group.
Coach at a Radiant level: hold off-angles instead of the spot they pre-aim, always set a crossfire so you have a trade, do not over-peek and give up your setup, use util to delay a push and buy rotation time, watch the minimap for rotates and flanks, and retake together not one by one. Catch and correct: over-peeking, no trade partner, predictable angles, dry retakes, and an unwatched flank.`
    : `SIDE UNKNOWN this frame. Keep advice fundamentals-first so it fits either side: trade, crossfires, util before peeking, minimap awareness, and economy discipline.`;

  const agentRule = ctx.agent
    ? ('The player is ' + ctx.agent + '. This is confirmed. Only ever suggest ' + ctx.agent + "'s own abilities, never another agent's. Before naming an ability, make sure it belongs to " + ctx.agent + '; if not, give a positioning, economy, or aim tip with no ability name.')
    : "The player's agent is not known yet. Do NOT name any agent or any specific ability. Give general advice only: positioning, crosshair placement, economy, rotation, or game sense.";

  return `You are a Radiant and professional level Valorant coach watching a live match through the player's screen. Give ONE short, specific, high-value tip, or the single word SKIP. Nothing else.

WHO THE PLAYER IS
The player is whoever the first-person view belongs to. Their agent is the one whose 4 ability icons sit at the BOTTOM-CENTER, just above the HP and shield bar. Never guess the player's agent from the scoreboard (top), the kill feed (top-right), or the minimap (top-left); those show all ten players. If the player is dead or spectating, coach what THEY did wrong before dying, not the spectated player.

${agentRule}

${sideBlock}

COACH LIKE A RADIANT PRO
Identify the single biggest thing the player is doing WRONG this frame, or the clearest opportunity, then give the fix. Prioritise what actually wins games at high elo: trading, crossfires, using util before peeking, crosshair placement, positioning and off-angles, timing, minimap and sound awareness, and economy discipline.
Movement abilities (Updraft, Dash, Satchel, Sprint) are RARELY the best advice; do not keep suggesting them, and never suggest the same ability or the same idea two tips in a row. If the best you can do is repeat a recent tip, change topic or reply SKIP. Vague or obvious tips ("play well", "get a kill") are worthless, be specific to what you see.

READ THE HUD
- Round and score: top-center, plus the round timer and whether it is buy phase.
- Credits: shown in buy phase; use them for economy advice.
- Bottom-center: the player's 4 abilities. Bright means ready, dim or greyed means used or not bought, so never tell them to use a greyed ability.
- Minimap (top-left): the player's position, teammates, and the spike.
- Center: crosshair placement and the angle being held.
- Kill feed (top-right): recent kills and trades.

ECONOMY (only when credits AND round are clearly visible).${buyNote}
- Round 1 or 13 pistol (~800): light shields plus one ability, or a Ghost. Nothing more.
- Under 2000: full save, buy nothing.
- 2000 to 3900: force buy, Spectre with light shields.
- 3900 or more: full buy, Vandal or Phantom with full shields and util.
- If the team is saving, save with them.

WHEN TO SPEAK vs SKIP
Speak when you can see a real mistake or a clear opportunity. Reply with exactly SKIP when the screen is a menu, agent select, or loading screen, when nothing has changed since your last tip, or when the only thing you could say repeats the recent tips below. Do not pad with generic ability suggestions.

${focusLine}CURRENT MATCH STATE (trust this, do not re-derive it every frame):
- Agent: ${ctx.agent || 'Unknown'} | Map: ${ctx.map || 'Unknown'} | Side: ${ctx.side || 'Unknown'}
- Round: ${ctx.roundNumber || 'Unknown'} | Score: ${ctx.teamScore || 0}-${ctx.enemyScore || 0} | Phase: ${ctx.phase || 'Unknown'}
- Credits: ${ctx.playerCredits == null ? 'Unknown' : ctx.playerCredits} | Alive: ${ctx.playerAlive === false ? 'No' : 'Yes'} | Deaths in a row: ${ctx.consecutiveDeaths || 0}

DO NOT REPEAT these recent tips, and do not rephrase the same idea a different way:
${recent}
Recent topics: ${topics}. Cover a DIFFERENT one this time (economy, positioning, utility, aim, rotation, spike, teamwork, mental).

ABILITY REFERENCE (only ever suggest the player's own; plain words like smoke, flash, molly, wall, recon are fine):
Jett: smokes, updraft, dash. Reyna: blind, heal, dismiss. Phoenix: flash, molly, wall. Raze: boombot, satchel, nade. Neon: walls, stun, sprint. Iso: shield, wall. Yoru: decoy, flash, teleport. Sova: drone, recon dart, shock. Breach: flash, stun, aftershock. Skye: flash, dog, heal. KAY/O: flash, suppress knife, molly. Fade: recon, tether, prowler. Gekko: flash, wingman, molly. Omen: smokes, flash, teleport. Brimstone: smokes, molly, stim. Viper: wall, smoke, molly. Astra: smokes, stun, wall. Harbor: walls, bubble. Clove: smokes, decay. Sage: wall, slow, heal. Killjoy: turret, molly, alarmbot. Cypher: tripwire, camera, cage. Chamber: trap, teleport, sheriff. Deadlock: wall, sensor, net. Vyse, Tejo, Waylay: only reference abilities you can actually see on screen.

OUTPUT
Reply with ONLY the tip: one plain sentence, 6 to 16 words, ending with a period. No quotes, no "Tip:", no JSON, no markdown, no preamble. Use commas and periods, never dashes. Always finish the sentence; never end on a preposition, article, conjunction, or possessive. If there is genuinely nothing worth saying, reply with exactly SKIP.

Good examples (attack):
Take map control mid before you commit, do not force site.
Trade your entry, swing the instant your teammate takes the duel.
Save one smoke for the post-plant, not the entry.
Good examples (defense):
Hold an off-angle, they pre-aim the default spot every round.
Fall back and retake as five, do not peek this alone.
Watch flank, your whole team is looking site.
SKIP`;
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
      visionInfer(image, prompt, 250, false),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout')), 10000)),
    ]);
    trackCall(licenseKey);

    let finalTip     = null;
    let finalContext = {};
    const rawStr = String(raw);
    console.log('[coach] Raw Gemini text length:', rawStr.length);
    console.log('[coach] Raw Gemini text:', rawStr.substring(0, 200));

    // Strip code fences first
    let cleaned = rawStr
      .replace(/```(?:json)?\s*\n?/gi, '')
      .replace(/```/g, '')
      .trim();

    // Try JSON first (in case Gemini still returns structured)
    const firstBrace = cleaned.indexOf('{');
    const lastBrace  = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        finalTip     = parsed.tip || null;
        finalContext = parsed.context || {};
        console.log('[coach] Parsed JSON successfully, tip:', finalTip);
      } catch (e) {
        const tipMatch = jsonStr.match(/"tip"\s*:\s*"((?:\\.|[^"\\])+)"/);
        if (tipMatch) {
          finalTip = tipMatch[1];
          console.log('[coach] Regex-extracted tip:', finalTip);
        }
      }
    }

    // No JSON — treat the whole response as a plain-text tip
    if (!finalTip) {
      let plain = cleaned
        .replace(/^here is the json requested:?\s*/i, '')
        .replace(/^here is the tip:?\s*/i, '')
        .replace(/^here'?s?\s+the\s+(json|tip|response):?\s*/i, '')
        .replace(/^sure[,!]?\s*/i, '')
        .replace(/^okay[,!]?\s*/i, '')
        .trim()
        .replace(/^["']|["']$/g, '');

      if (plain.toUpperCase() === 'SKIP') {
        finalTip = 'SKIP';
        console.log('[coach] Plain SKIP response');
      } else if (plain.length >= 10 && plain.length <= 200) {
        finalTip = plain;
        console.log('[coach] Using plain text as tip:', finalTip);
      } else {
        console.log('[coach] Plain text rejected - length', plain.length);
      }
    }

    if (finalTip && typeof finalTip !== 'string') finalTip = String(finalTip);

    let tip    = sanitize(finalTip || '');
    let outCtx = finalContext;
    console.log('[coach] FINAL TIP:', tip.slice(0, 100));

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
      visionInfer(req.body.toString('base64'), ROUND_SUMMARY_PROMPT, 400),
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
      textInfer(sysPrompt, 600),
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
      textInfer(prompt, 100),
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
      textInfer(prompt, 200),
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

// POST /api/coach/detect-agent — JSON body: { image: base64 }
// Cheap one-shot agent detection. Used at session start to lock the agent.
router.post('/detect-agent', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const image = req.body && req.body.image;
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'No image' });

    const prompt = `Look at this Valorant screenshot. The player has 4 ability icons at the BOTTOM-CENTER of the screen, just above their HP bar.

Identify the player's agent by matching those 4 ability icons to one of these agents:

Jett: Cloudburst smoke, Updraft jump, Tailwind dash, Blade Storm knife ult
Reyna: Leer eye, Devour heal, Dismiss escape, Empress ult
Phoenix: Curveball flash, Hot Hands molly, Blaze fire wall, Run It Back ult
Raze: Boom Bot, Blast Pack satchel, Paint Shells nade, Showstopper rocket
Neon: Fast Lane walls, Relay Bolt stun, High Gear sprint, Overdrive beam
Iso: Undercut, Double Tap shield, Contingency wall, Kill Contract
Yoru: Fakeout decoy, Blindside flash, Gatecrash teleport, Dimensional Drift
Sova: Owl Drone, Shock Bolt, Recon Bolt, Hunter's Fury
Breach: Flashpoint, Fault Line, Aftershock, Rolling Thunder
Skye: Trailblazer dog, Guiding Light bird, Regrowth, Seekers
KAY/O: FLASH/drive, ZERO/point knife, FRAG/ment, NULL/cmd
Fade: Prowler, Seize tether, Haunt eye, Nightfall
Gekko: Wingman, Dizzy, Mosh Pit, Thrash
Tejo
Omen: Shrouded Step teleport, Paranoia blind, Dark Cover smokes, From The Shadows
Brimstone: Stim Beacon, Incendiary, Sky Smoke, Orbital Strike
Viper: Snake Bite, Poison Cloud, Toxic Screen wall, Viper's Pit
Astra: Gravity Well, Nova Pulse, Nebula smoke, Cosmic Divide
Harbor: Cove bubble, High Tide wall, Cascade, Reckoning
Clove: Pick-Me-Up, Meddle, Ruse smokes, Not Dead Yet
Sage: Slow Orb, Healing Orb, Barrier wall, Resurrection
Killjoy: Nanoswarm, Alarmbot, Turret, Lockdown
Cypher: Trapwire, Cyber Cage smoke, Spycam, Neural Theft
Chamber: Trademark, Headhunter, Rendezvous, Tour De Force
Deadlock: GravNet, Sonic Sensor, Barrier Mesh, Annihilation
Vyse, Waylay

Respond with ONLY the agent name. Just one word. No explanation. No punctuation.

If you cannot clearly see all 4 ability icons or are not 100% sure, respond with: UNKNOWN`;

    const text = await Promise.race([
      visionInfer(image, prompt, 20, false),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    trackCall(licenseKey);

    const validAgents = ['Jett','Reyna','Phoenix','Raze','Neon','Iso','Yoru','Sova','Breach','Skye','KAY/O','Fade','Gekko','Tejo','Omen','Brimstone','Viper','Astra','Harbor','Clove','Sage','Killjoy','Cypher','Chamber','Deadlock','Vyse','Waylay'];
    const cleanText = String(text || '').trim();
    const detected  = validAgents.find(a => cleanText.toLowerCase().includes(a.toLowerCase()));

    console.log('[coach] Agent detection - raw:', cleanText.slice(0, 40), 'matched:', detected);
    res.json({ agent: detected || null });
  } catch (e) {
    console.error('[coach] detect-agent error:', e.message);
    res.json({ agent: null });
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
      textInfer(prompt, 100),
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
