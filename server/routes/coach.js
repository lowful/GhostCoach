'use strict';
const express  = require('express');
const supabase = require('../db/supabase');
const router = express.Router();

// ─── Cost tracking (in-memory, resets on server restart) ──────────────────────
const costStore   = new Map();
const globalStats = { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '' };
const COST_PER_CALL = (2200 * 0.00000013) + (40 * 0.00000052); // Qwen3-VL, ~$0.0003

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

// ─── Direct Gemini REST call, tries primary model, falls back if 404 ─────────
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

// Strict schema for /analyze responses, Gemini requires UPPERCASE type names
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
  const transLine  = ctx.phaseTransition
    ? ('THE PHASE JUST CHANGED (' + ctx.phaseTransition + '). Coach the NEW phase first: buy advice as buy phase opens, setup or positioning as the round starts, post-plant or retake play the moment the spike is planted.\n\n')
    : '';
  const memoryBlock = Array.isArray(ctx.matchMemory) && ctx.matchMemory.length
    ? ('MATCH MEMORY (what has happened so far, use it for continuity, momentum reads, and patterns):\n'
       + ctx.matchMemory.slice(-8).map((m) => '- ' + String(m).slice(0, 90)).join('\n') + '\n\n')
    : '';
  const side       = String(ctx.side || '').toLowerCase();

  const sideBlock = side.includes('att')
    ? `YOU ARE ON ATTACK. The goal is to take space with utility, trade your entries, and hit a site together, then win the post-plant.
Coach at a Radiant level: gather info before committing, use util to clear or take an angle BEFORE you peek, stay in trade range with a teammate, take map control on defaults instead of forcing, plant in a spot the team can protect, and save util for the post-plant. Catch and correct: dry peeks, wasted early util, lurking too deep with no impact, planting in the open, and solo plays with no trade.`
    : side.includes('def')
    ? `YOU ARE ON DEFENSE. The goal is to get early picks, hold with crossfires, gather info, delay with util, and retake as a group.
Coach at a Radiant level: hold off-angles instead of the spot they pre-aim, always set a crossfire so you have a trade, do not over-peek and give up your setup, use util to delay a push and buy rotation time, watch the minimap for rotates and flanks, and retake together not one by one. Catch and correct: over-peeking, no trade partner, predictable angles, dry retakes, and an unwatched flank.`
    : `SIDE UNKNOWN this frame. Keep advice fundamentals-first so it fits either side: trade, crossfires, util before peeking, minimap awareness, and economy discipline.`;

  const s = ctx.playerStats;
  const profileBlock = s && !s.error
    ? `PLAYER PROFILE (career tracker stats): rank ${s.rank || 'unknown'}, K/D ${s.kd || '?'}, headshot ${s.headshotPct || '?'}%, win rate ${s.winRate || '?'}%, top agent ${s.topAgent || 'unknown'}.
Use these stats to decide WHAT to prioritise, then combine that with what the screenshot actually shows this frame. The strongest tip is a career weakness that also shows up on screen right now. Never give a stat-based tip the frame does not support.
Aim read: 20% headshots and up is good, do not nitpick it; below 20% means aim needs work, so when you see whiffs, low crosshair, or spraying at range, coach crosshair placement and aim.
K/D read: under 1.0 means they trade themselves too often, favor positioning, patience, and trading; 1.3 and up means they frag well, push impact, round wins, and playing for the team.
Rank read: lower ranks (Iron to Gold) want fundamentals; higher ranks (Plat and up) want utility timing, off-angles, tempo, and info.
Aim and game sense matter together: if their aim is fine, coach the tactical mistake you see instead.

`
    : '';

  const agentRule = ctx.agent
    ? ('The player is ' + ctx.agent + '. This is confirmed. Only ever suggest ' + ctx.agent + "'s own abilities, never another agent's. Before naming an ability, make sure it belongs to " + ctx.agent + '; if not, give a positioning, economy, or aim tip with no ability name.')
    : "The player's agent is not known yet. Do NOT name any agent or any specific ability. Give general advice only: positioning, crosshair placement, economy, rotation, or game sense.";

  return `You are a Radiant and professional level Valorant coach watching a live match through the player's screen. Give ONE short, specific, high-value tip, or the single word SKIP. Nothing else.

WHO THE PLAYER IS
The player is whoever the first-person view belongs to. Their agent is the one whose 4 ability icons sit at the BOTTOM-CENTER, just above the HP and shield bar. Never guess the player's agent from the scoreboard (top), the kill feed (top-right), or the minimap (top-left); those show all ten players. If the player is dead or spectating, coach what THEY did wrong before dying, not the spectated player.

${agentRule}

${profileBlock}${sideBlock}

COACH LIKE A RADIANT PRO
Identify the single biggest thing the player is doing WRONG this frame, or the clearest opportunity, then give the fix. Prioritise what actually wins games at high elo: trading, crossfires, using util before peeking, crosshair placement, positioning and off-angles, timing, minimap and sound awareness, and economy discipline.
Do NOT invent a positive reason for a bad habit. If you see a mistake, correct it, do not praise it.

ABILITY AND WEAPON SANITY (critical):
- BEFORE suggesting ANY ability, look at the bottom-center ability bar in THIS screenshot and confirm that exact ability icon is bright and available. Greyed, dim, or missing means it is unbought or already used, so suggest something else. On pistol rounds and ecos assume abilities are NOT bought unless you can clearly see them lit.
- Match every ability to what it actually does. Updraft, Tailwind, High Gear, Satchel and Sprint are MOBILITY, they do not clear, check, or hold an angle or a flank. Never say "use Updraft to clear the flank" or similar nonsense.
- Only suggest an ability when the situation genuinely calls for it and there is space or a clear reason (taking height or an off-angle, escaping, entering with a flash or smoke, denying a plant). If there is no clear use, coach positioning, aim, trading, or economy instead. Never suggest an ability just to mention one.
- Holding the KNIFE out is only for running to position during the buy phase (barriers up) with no enemies near. Once the round is live (active or post-plant), an out knife is a MISTAKE because the player cannot shoot: tell them to switch to their gun. Never praise holding a knife in a live round.

BE SPECIFIC, NEVER VAGUE
Vague or contradictory advice is worthless and forbidden. Never produce filler like "do not enter from the open and get high ground". Every tip must name the concrete action: which angle to hold, where exactly to stand, when to rotate, what to buy, or which util to use and where. If you cannot be that specific from this frame, pick a different topic you CAN be specific about, or SKIP.

PROVEN HIGH-ELO HABITS (distilled from Radiant, Immortal, and pro play; prefer these over generic advice):
- Take fights with a trade partner in view; a solo pick is only worth it on real info.
- Clear angles in slices from cover; never wide-swing into multiple uncleared angles at once.
- Use util to take space, then HOLD the space you took; never re-peek a fight you already won.
- Attack: default for info first, then commit as five behind util; always keep one smoke or flash for post-plant.
- Defense: play an off-angle once, then rotate spots; give ground when man-down and retake together with util.
- Economy: full save under 2000, never half-buy alone, match your team's buy every round.
- Reposition after nearly every kill; pros almost never repeek the same pixel.

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

WHEN TO SPEAK, SKIP, or LOBBY
Most gameplay frames deserve one sharp, useful observation, so give it: a mistake, an opportunity, a read, an economy call, or a positioning fix.
If the screen is NOT live gameplay (main menu, lobby, agent select, loading screen, career or collection page, range with no match), reply with exactly LOBBY.
Reply with exactly SKIP only when it IS live gameplay but the only honest thing you could say repeats the recent tips below. Never pad with generic ability suggestions.

${memoryBlock}${transLine}${focusLine}CURRENT MATCH STATE (trust this, do not re-derive it every frame):
- Agent: ${ctx.agent || 'Unknown'} | Map: ${ctx.map || 'Unknown'} | Side: ${ctx.side || 'Unknown'}
- Round: ${ctx.roundNumber || 'Unknown'} | Score: ${ctx.teamScore || 0}-${ctx.enemyScore || 0} | Phase: ${ctx.phase || 'Unknown'}
- Credits: ${ctx.playerCredits == null ? 'Unknown' : ctx.playerCredits} | Alive: ${ctx.playerAlive === false ? 'No' : 'Yes'} | Deaths in a row: ${ctx.consecutiveDeaths || 0}

DO NOT REPEAT these recent tips, and do not rephrase the same idea a different way:
${recent}
${Array.isArray(ctx.badTips) && ctx.badTips.length ? 'The player marked these tips as unhelpful, avoid this advice and anything similar:\n' + ctx.badTips.slice(0, 6).map((t) => '- ' + t).join('\n') + '\n' : ''}
Recent topics: ${topics}. Cover a DIFFERENT one this time (economy, positioning, utility, aim, rotation, spike, teamwork, mental).

ABILITY REFERENCE (only ever suggest the player's own; plain words like smoke, flash, molly, wall, recon are fine):
Jett: smokes, updraft, dash. Reyna: blind, heal, dismiss. Phoenix: flash, molly, wall. Raze: boombot, satchel, nade. Neon: walls, stun, sprint. Iso: shield, wall. Yoru: decoy, flash, teleport. Sova: drone, recon dart, shock. Breach: flash, stun, aftershock. Skye: flash, dog, heal. KAY/O: flash, suppress knife, molly. Fade: recon, tether, prowler. Gekko: flash, wingman, molly. Omen: smokes, flash, teleport. Brimstone: smokes, molly, stim. Viper: wall, smoke, molly. Astra: smokes, stun, wall. Harbor: walls, bubble. Clove: smokes, decay. Sage: wall, slow, heal. Killjoy: turret, molly, alarmbot. Cypher: tripwire, camera, cage. Chamber: trap, teleport, sheriff. Deadlock: wall, sensor, net. Vyse, Tejo, Waylay: only reference abilities you can actually see on screen.

OUTPUT
Reply with ONLY the tip: one plain sentence, 6 to 16 words, ending with a period. No quotes, no "Tip:", no JSON, no markdown, no preamble. Use commas and periods, never dashes. Always finish the sentence; never end on a preposition, article, conjunction, or possessive. If it is live gameplay with nothing new to say, reply with exactly SKIP. If it is not live gameplay at all, reply with exactly LOBBY.

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

// POST /api/coach/analyze, JSON body: { image: base64, context: {...} }
router.post('/analyze', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();

  if (!licenseKey) return res.status(400).json({ error: 'X-License-Key header required' });
  if (!await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid or expired license key' });

  const image   = req.body && req.body.image;
  const context = (req.body && req.body.context) || {};
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'No image data' });

  const isForced = req.headers['x-forced'] === 'true';
  const prompt   = buildContextPrompt(context) + (isForced
    ? '\n\nOVERRIDE: The player manually requested coaching. Always give a real tip, do not respond with SKIP.'
    : '');

  const t0 = Date.now();
  try {
    const raw = await Promise.race([
      visionInfer(image, prompt, 120, false),
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

    // No JSON, treat the whole response as a plain-text tip
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
      } else if (plain.toUpperCase() === 'LOBBY') {
        finalTip = 'LOBBY';   // not live gameplay: client silences all tips
        console.log('[coach] LOBBY response');
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
    if (tip && tip !== 'SKIP' && tip !== 'LOBBY' && tip !== 'VICTORY' && tip !== 'DEFEAT') {
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

// POST /api/coach/summary/round, raw binary JPEG body
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

// POST /api/coach/summary/match, JSON body: { tips: string[] }
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

// POST /api/coach/recap, JSON body: { tips: string[] }
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

// ─── Player stats providers ───────────────────────────────────────────────────
async function henrikGet(pathPart) {
  const r = await fetch('https://api.henrikdev.xyz' + pathPart, {
    headers: { Authorization: process.env.HENRIKDEV_API_KEY, 'User-Agent': 'GhostCoach/2.0' },
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, json };
}

// HenrikDev works from datacenter IPs (unlike tracker.gg). Resolve region from
// the account, read the current rank, then aggregate recent competitive matches
// for a rough K/D and headshot %. Returns { stats } or { fail: 'reason' }.
async function henrikStats(name, tag) {
  const enc = encodeURIComponent;
  const acct = await henrikGet(`/valorant/v2/account/${enc(name)}/${enc(tag)}`);
  if (acct.status === 401 || acct.status === 403) return { fail: 'HenrikDev key rejected (401/403). Check HENRIKDEV_API_KEY.' };
  if (acct.status === 404) return { fail: 'HenrikDev could not find that Riot ID. Check Name#TAG is exact.' };
  if (acct.status === 429) return { fail: 'HenrikDev rate limit hit. Wait a minute and try again.' };
  const region = acct.json && acct.json.data && acct.json.data.region;
  if (!region) return { fail: 'HenrikDev returned no region for that account (status ' + acct.status + ').' };

  const mmr = await henrikGet(`/valorant/v2/mmr/${region}/${enc(name)}/${enc(tag)}`);
  const rank = mmr.json && mmr.json.data && mmr.json.data.current_data && mmr.json.data.current_data.currenttierpatched;

  let kd = 0, headshotPct = 0;
  try {
    const sm = await henrikGet(`/valorant/v1/stored-matches/${region}/${enc(name)}/${enc(tag)}?mode=competitive&size=8`);
    const matches = (sm.json && Array.isArray(sm.json.data)) ? sm.json.data : [];
    let k = 0, d = 0, head = 0, shots = 0, counted = 0;
    for (const m of matches) {
      const st = m && m.stats;
      if (!st) continue;
      k += st.kills || 0; d += st.deaths || 0;
      const sh = st.shots || {};
      const h = sh.head || 0, b = sh.body || 0, l = sh.leg || 0;
      head += h; shots += h + b + l; counted++;
    }
    if (d > 0) kd = +(k / d).toFixed(2);
    if (shots > 0) headshotPct = Math.round((head / shots) * 100);
    if (!counted && !rank) return { fail: 'No recent competitive matches or rank found for that account.' };
  } catch { /* rank-only is still useful */ }

  if (!rank && !kd) return { fail: 'HenrikDev found the account but no rank or match data yet.' };
  return { stats: { source: 'henrikdev', rank: rank || 'Unranked', kd, winRate: 0, headshotPct, topAgent: 'Unknown' } };
}

async function trackerStats(name, tag) {
  try {
    const url = `https://api.tracker.gg/api/v2/valorant/standard/profile/riot/${encodeURIComponent(name)}%23${encodeURIComponent(tag)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GhostCoach/2.0', 'TRN-Api-Key': process.env.TRACKER_API_KEY },
    });
    const text = await response.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (response.ok && data) {
      const stats = data?.data?.segments?.[0]?.stats;
      if (stats) {
        return { stats: {
          source:      'tracker.gg',
          rank:        stats?.rank?.metadata?.tierName || 'Unknown',
          kd:          stats?.kDRatio?.value             || 0,
          winRate:     stats?.matchesWinPct?.value       || 0,
          headshotPct: stats?.headshotsPercentage?.value || 0,
          topAgent:    data?.data?.segments?.[1]?.metadata?.name || 'Unknown',
        } };
      }
    }
    // 403 with an HTML body is the tell-tale Cloudflare datacenter block.
    const blocked = response.status === 403 || response.status === 429 || !data;
    return { fail: blocked
      ? 'tracker.gg blocked the server (status ' + response.status + '). This is expected on cloud hosts, use a HenrikDev key instead.'
      : 'tracker.gg returned no stats (status ' + response.status + ').' };
  } catch (e) {
    return { fail: 'tracker.gg was unreachable: ' + e.message };
  }
}

// GET /api/coach/player-stats?username=Name%23TAG
router.get('/player-stats', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

  const username = String(req.query.username || '');
  if (!username.includes('#')) return res.json({ error: 'Enter your Riot ID as Name#TAG.' });
  const [name, tag] = username.split('#').map((s) => s.trim());
  if (!name || !tag) return res.json({ error: 'Enter your Riot ID as Name#TAG.' });

  const reasons = [];

  // 1) HenrikDev first: it actually works from Railway/cloud IPs.
  if (process.env.HENRIKDEV_API_KEY) {
    const r = await henrikStats(name, tag).catch((e) => ({ fail: 'HenrikDev error: ' + e.message }));
    if (r.stats) { console.log('[stats] henrikdev ok:', r.stats.rank); return res.json(r.stats); }
    if (r.fail) reasons.push(r.fail);
  }

  // 2) tracker.gg fallback (usually Cloudflare-blocked on cloud hosts).
  if (process.env.TRACKER_API_KEY) {
    const r = await trackerStats(name, tag).catch((e) => ({ fail: 'tracker.gg error: ' + e.message }));
    if (r.stats) { console.log('[stats] tracker.gg ok:', r.stats.rank); return res.json(r.stats); }
    if (r.fail) reasons.push(r.fail);
  }

  if (!process.env.HENRIKDEV_API_KEY && !process.env.TRACKER_API_KEY) {
    return res.json({ error: 'No stats provider is configured on the server. Add HENRIKDEV_API_KEY in Railway.' });
  }
  console.warn('[stats] all providers failed for', username, '::', reasons.join(' | '));
  res.json({ error: reasons[0] || 'Could not load that profile. Check the Riot ID is exact.' });
});

// POST /api/coach/match-review, JSON body: { tips: string[] }
router.post('/match-review', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const tips = Array.isArray(req.body && req.body.tips) ? req.body.tips.slice(0, 30) : [];
    if (tips.length < 3) return res.json({ review: 'Not enough data for a review.' });

    const prompt = `Here are the coaching tips shown to a Valorant player during one match:\n${tips.join('\n')}\n\nWrite a 3-sentence match review. Sentence 1: the area the coaching pushed most, framed as what to keep building on. Sentence 2: the most repeated correction, that is their most common issue. Sentence 3: the single focus for next match, stated as a concrete habit or drill they can actually do (for example a minimap glance every 5 seconds, or trading every teammate fight), not a vague goal.\n\nCRITICAL GROUNDING RULE: these tips are the ONLY thing you know about the match. Do not invent or assume specific plays, kills, clutches, or moments, and do not claim the player DID something unless the tips clearly show it. Talk about what the coaching focused on, not fabricated events. If the tips do not support a claim, leave it out. Do not use dashes. End each sentence with a period.`;

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

// POST /api/coach/detect-agent, JSON body: { image: base64 }
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

// POST /api/coach/suggest-library-tip, JSON body: { context, availableTips: string[] }
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

// Chat reply hygiene: strip markdown/code artifacts, then verify the reply is
// an actual coaching answer (not a refusal, JSON blob, or empty fragment).
function cleanChatReply(raw) {
  return sanitize(String(raw || ''))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function chatReplyOk(t) {
  if (!t || t.length < 25) return false;
  if (/\b(as an ai|i cannot assist|i can.?t help with|language model|i am unable to|no puedo)\b/i.test(t)) return false;
  if (/^\s*[{[]/.test(t) || /"(tip|role|content|reply)"\s*:/.test(t)) return false;   // raw JSON
  return true;
}

// POST /api/coach/chat, JSON body: { messages: [{role,content}], context: {...}, image? }
// The "Ask Coach" conversation: post-match reviews, "what did I do wrong", etc.
// Flattens the conversation into one prompt so it works on any provider, and
// attaches the player's screenshot when the client sends one.
router.post('/chat', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const body     = req.body || {};
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .slice(-12)
      .map((m) => ({
        role:    m && m.role === 'assistant' ? 'Coach' : 'Player',
        content: String((m && m.content) || '').slice(0, 1200),
      }))
      .filter((m) => m.content);
    if (!messages.length) return res.status(400).json({ error: 'No messages' });

    const ctx   = body.context || {};
    const image = typeof body.image === 'string' && body.image.length > 100 ? body.image : null;

    const statsLine = ctx.stats && !ctx.stats.error
      ? `Their tracker profile: rank ${ctx.stats.rank || 'unknown'}, K/D ${ctx.stats.kd || '?'}, win rate ${ctx.stats.winRate || '?'}%, headshot ${ctx.stats.headshotPct || '?'}%, top agent ${ctx.stats.topAgent || 'unknown'}. Note: 20% headshots or higher is good; below 20% means aim training helps. Aim is only one part, weigh it against their game sense, positioning, and decisions too.`
      : 'No tracker stats available.';
    const tipsBlock = Array.isArray(ctx.sessionTips) && ctx.sessionTips.length
      ? 'Coaching tips given this session (newest first):\n' + ctx.sessionTips.slice(0, 20).map((t) => '- ' + String(t).slice(0, 140)).join('\n')
      : 'No tips recorded this session yet.';
    const memLine = Array.isArray(ctx.matchMemory) && ctx.matchMemory.length
      ? 'Match flow so far: ' + ctx.matchMemory.slice(-8).map((m) => String(m).slice(0, 80)).join('; ') + '.'
      : '';

    const prompt = `You are GhostCoach, a Radiant-level Valorant coach talking directly with your player after (or during) a session. Be honest, specific, and encouraging, like a real coach in a VOD review. Casual tone, no fluff.

${statsLine}
Player's agent this session: ${ctx.agent || 'unknown'}.
${memLine}
${tipsBlock}
${image ? 'Attached is a frame from the player\'s OWN recorded gameplay, captured during their coaching session' + (ctx.frameAgeMin != null ? ' about ' + ctx.frameAgeMin + ' minute(s) ago' : '') + '. Ground your points in what it actually shows, and reference it when it helps the player understand what you mean. Do not describe it as a live screen.' : ''}
${ctx.noSessionYet ? 'IMPORTANT: this player has NOT played a coached session yet. You have no gameplay, no tips, and no screenshots from them. Do not invent observations about their play. Answer general Valorant questions briefly and invite them to start coaching and play a match so you can review it together.' : ''}

Conversation so far:
${messages.map((m) => m.role + ': ' + m.content).join('\n')}

Reply as Coach to the player's last message. Rules:
- Only discuss Valorant and the player's gaming performance. If asked about anything unrelated, steer back to their gameplay in one friendly sentence.
- COACH LIKE THE BEST: first diagnose the ROOT CAUSE behind what they are asking (deaths usually trace to positioning, timing, or fighting without a trade partner before they trace to aim). Name the ONE highest-impact fix, then give a concrete drill or in-game habit to build it, for example 10 minutes of deathmatch focusing only on counter-strafe headshots, a minimap glance every 5 seconds, or reviewing one lost round per match and asking what info they had before the fight.
- Ground advice in proven Radiant and pro fundamentals: fight with a trade partner in view, clear angles in slices, use util before contact, take an off-angle once then move, keep economy discipline, reposition after kills.
- Combine their career stats with what you can see (the screenshot, the match flow, and this session's tips). The best answer ties a stat to a concrete example, and covers both aim and game sense, not just headshot rate.
- Be honest, do not praise a mistake as if it were good. Holding a knife out in a live round is a mistake (they cannot shoot), not smart map control. Match abilities to their real purpose (Updraft and dashes are mobility, not tools to clear angles).
- Be concrete: name the exact habit or mistake and the fix, not generalities.
- 2 to 5 short sentences, under 120 words total. Plain text, no markdown, no lists.
- Use commas and periods, never dashes.
- If you genuinely lack the information to answer, say what you'd need to see.`;

    const ask = (p) => Promise.race([
      image ? visionInfer(image, p, 350, false) : textInfer(p, 350),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
    ]);

    let reply = cleanChatReply(await ask(prompt));
    trackCall(licenseKey);
    if (!chatReplyOk(reply)) {
      // One retry with an explicit correction; never ship a broken answer.
      console.warn('[chat] reply failed quality gate, retrying:', reply.slice(0, 80));
      reply = cleanChatReply(await ask(prompt +
        '\n\nYour previous reply was unusable. Answer plainly, in a few sentences, strictly about the player\'s Valorant gameplay.'));
      trackCall(licenseKey);
    }
    if (!chatReplyOk(reply)) {
      reply = 'Let\'s keep it on your gameplay. Ask me about a specific round, your aim, positioning, or economy and I\'ll break it down.';
    }
    res.json({ reply: reply.slice(0, 1500) });
  } catch (e) {
    console.error('[coach] chat error:', e.message);
    res.status(500).json({ error: 'Chat failed' });
  }
});

module.exports = router;
module.exports.costStore   = costStore;
module.exports.globalStats = globalStats;
