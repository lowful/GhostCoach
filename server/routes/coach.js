'use strict';
const express  = require('express');
const supabase = require('../db/supabase');
const knowledge = require('../services/knowledge');
const router = express.Router();

// ─── Cost tracking (in-memory, resets on server restart) ──────────────────────
const costStore   = new Map();
const globalStats = { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '' };
const COST_PER_CALL = (2200 * 0.00000013) + (40 * 0.00000052); // Qwen3-VL, ~$0.0003

function trackCall(key, units = 1) {           // units: frame-memory calls send 2 images
  const cost  = COST_PER_CALL * units;
  const today = new Date().toISOString().slice(0, 10);
  if (globalStats.date !== today) {
    globalStats.callsToday = 0;
    globalStats.costToday  = 0;
    globalStats.date = today;
  }
  globalStats.callsToday++;
  globalStats.callsMonth++;
  globalStats.costToday  += cost;
  globalStats.costMonth  += cost;

  if (!costStore.has(key)) costStore.set(key, { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '' });
  const e = costStore.get(key);
  if (e.date !== today) { e.callsToday = 0; e.costToday = 0; e.date = today; }
  e.callsToday++;
  e.callsMonth++;
  e.costToday  += cost;
  e.costMonth  += cost;
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
  // HYBRID vision: the fast instruct model runs live action (reliable, timely),
  // and the deep reasoning model runs buy-phase reads (the pre-round minimap
  // plan, where a 30-40s barrier gives it time to reason). The analyze route
  // picks between them by phase. Text tasks (grading, chat, reviews) are not
  // latency bound, so they use the reasoning model too.
  visionModel: process.env.AI_VISION_MODEL      || 'qwen/qwen3-vl-235b-a22b-instruct',  // live action
  visionDeep:  process.env.AI_VISION_MODEL_DEEP || 'qwen/qwen3-vl-235b-a22b-thinking',  // buy-phase reads
  textModel:   process.env.AI_TEXT_MODEL        || 'qwen/qwen3-vl-235b-a22b-thinking',
};

// One OpenAI-style chat call. `imageB64` present => multimodal (vision) request.
// Accepts a single base64 string or an ordered array (frame memory sends
// [previousFrame, currentFrame]; the prompt explains the order).
async function chatCall({ prompt, imageB64, maxTokens, temperature, model: pinnedModel }) {
  const images  = Array.isArray(imageB64) ? imageB64 : (imageB64 ? [imageB64] : []);
  const content = images.length
    ? [
        { type: 'text', text: prompt },
        ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } })),
      ]
    : prompt;

  // The caller can pin a model (the hybrid runs the deep reasoning model on
  // buy-phase reads and the fast model on live action); otherwise use the
  // configured vision/text model.
  const model = pinnedModel || (images.length ? AI.visionModel : AI.textModel);
  // Thinking models spend tokens reasoning BEFORE the answer, so a small answer
  // budget would truncate before any tip appears. Give reasoning headroom on
  // top of the caller's budget, bounded so total generation lands inside the
  // timeouts. A no-op for instruct models (headroom 0), safe either way.
  const isThinking = /thinking/i.test(model);
  const budget = (maxTokens || 100) + (isThinking ? 700 : 0);

  const resp = await fetch(`${AI.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${AI.apiKey}`,
      'HTTP-Referer':  'https://ghostcoachai.com', // OpenRouter attribution (ignored elsewhere)
      'X-Title':       'GhostCoach',
    },
    body: JSON.stringify({
      model,
      messages:    [{ role: 'user', content }],
      max_tokens:  budget,
      temperature: temperature == null ? 0.7 : temperature,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[coach] AI error (${resp.status}):`, text.slice(0, 200));
    throw new Error(`AI ${resp.status}`);
  }
  const data = await resp.json();
  const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return stripThinking(raw);
}

// Thinking models wrap their reasoning in <think>...</think> before the answer.
// Strip it so the tip and STATE parsing only ever see the final answer. Handles
// closed blocks, a dangling close (reasoning with no open tag), and a dangling
// open (truncated mid-thought, nothing usable after it). No-op on plain output.
function stripThinking(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');   // closed reasoning blocks
  if (/<\/think>/i.test(s)) s = s.replace(/^[\s\S]*<\/think>/i, ' ');  // dangling close: drop up to it
  s = s.replace(/<think>[\s\S]*$/i, ' ');             // dangling open (truncated): drop to end
  return s.trim();
}

// Unified entry points the routes call: dispatch to the configured provider.
async function visionInfer(imageB64, prompt, maxTokens, jsonMode, model) {
  if (AI.provider === 'gemini') return geminiCall(imageB64, prompt, maxTokens, jsonMode);
  const text = await chatCall({ imageB64, prompt, maxTokens, temperature: 0.7, model });
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

  const images = Array.isArray(imageB64) ? imageB64 : (imageB64 ? [imageB64] : []);
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        ...images.map((img) => ({ inlineData: { mimeType: 'image/jpeg', data: img } })),
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

// ─── Game-audio understanding (death forensics) ──────────────────────────────
// Turns the last seconds of game audio into VERIFIED sound facts. Runs on
// Gemini (the only configured provider with audio ears); when no Gemini key
// is set, audio silently adds nothing. Strictly no-guess: unsure = omit.
async function geminiAudioEvents(audioB64) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return '';

  const prompt = 'This is the last few seconds of Valorant GAME AUDIO from right before and as a player died. List ONLY the sounds you can clearly identify, one short line each, in the order they happen: running or walking footsteps, gunfire (and roughly how long or how many shots), reload sounds, ability sounds, ult voice lines, spike plant or defuse beeps, a death sound. Ignore music, lobby sounds, and human voice chat entirely. If you cannot clearly identify a sound, leave it out, never guess. Maximum 6 lines, plain text, no dashes, no preamble.';
  const body = JSON.stringify({
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType: 'audio/wav', data: audioB64 } },
    ] }],
    generationConfig: { maxOutputTokens: 130, temperature: 0.2 },
  });

  let lastError;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (response.status === 404) { lastError = new Error(`404 for model ${model}`); continue; }
      if (!response.ok) throw new Error(`Gemini audio ${response.status}`);
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return text.replace(/[\u2014\u2013]/g, ', ').trim();
    } catch (err) {
      if (String(err.message).startsWith('404 for model')) { lastError = err; continue; }
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
  const lastShown  = recentList.length ? String(recentList[recentList.length - 1]).slice(0, 160) : null;
  const topics     = (Array.isArray(ctx.recentTopics) && ctx.recentTopics.length) ? ctx.recentTopics.join(', ') : 'none yet';
  const focusLine  = ctx.focus ? ('This frame, lean toward: ' + ctx.focus + '.\n\n') : '';
  const transLine  = ctx.phaseTransition
    ? ('THE PHASE JUST CHANGED (' + ctx.phaseTransition + '). Coach the NEW phase first: buy advice as buy phase opens, setup or positioning as the round starts, post-plant or retake play the moment the spike is planted.\n\n')
    : '';
  const memoryBlock = Array.isArray(ctx.matchMemory) && ctx.matchMemory.length
    ? ('MATCH MEMORY (what has happened so far, use it for continuity, momentum reads, and predictions):\n'
       + ctx.matchMemory.slice(-10).map((m) => '- ' + String(m).slice(0, 90)).join('\n') + '\n\n')
    : '';
  const roundLostLine = !ctx.justDied && ctx.justLostRound
    ? 'YOUR TEAM JUST LOST THE ROUND. If the frames and match memory CLEARLY show why the round slipped (a lost man advantage, a failed retake, spike left too late, the player caught somewhere useless), give the round review: start line 1 with exactly "DEATH: " then name what lost the round and the fix in one sentence. If you cannot actually see why it was lost, do NOT guess, coach something else or SKIP.\n\n'
    : '';
  const deathLine = ctx.justDied
    ? 'THE PLAYER JUST DIED. If the frames, match memory, and state CLEARLY show why (a dry peek, no trade partner in range, repeeking the same angle, a bad position, fighting without util), make this tip the DEATH REVIEW: start line 1 with exactly "DEATH: " then name the cause and the exact fix in one sentence. This is also where held-back observations belong, if you noticed a mistake earlier, chose not to interrupt, and it just got them killed, say it now. Name the PLACE of the death only when the death frames or match memory actually show it, look back at what you were sent instead of assuming; a review that guesses the location teaches the player to distrust every review. But if the death looks unlucky, a fair duel simply lost, or you cannot actually see the cause, do NOT guess and do NOT invent a reason, coach something else or SKIP. A wrong death explanation is worse than none.\n\n'
    : '';
  const side       = String(ctx.side || '').toLowerCase();
  // Game mode drives the halftime arithmetic. The client locks it from HUD
  // reads and score math; until then the model is told exactly how each mode's
  // halves work so a swiftplay round 5 swap never gets called with 12-round math.
  const modeLine = ctx.gameMode === 'swiftplay'
    ? 'SWIFTPLAY (first to 5: halves are 4 rounds, sides swap at round 5, a 4-4 tie plays sudden death round 9)'
    : ctx.gameMode === 'standard'
    ? 'Unrated or Competitive (first to 13: halves are 12 rounds, sides swap at round 13, overtime from round 25 alternates every round)'
    : 'Unknown, report it in STATE mode the moment you can actually read it';

  const sideBlock = side.includes('att')
    ? `YOU ARE ON ATTACK. Attack is initiative: your team picks where and when the fight happens. Take map control with util, gather info, then commit as five, trade every entry, plant for cover, win the post-plant.
Coach at a Radiant level: use util BEFORE you peek, stay in trade range, default until you have a read then hit fast (tempo is a weapon), keep one smoke or flash for the post-plant, and make sure someone watches YOUR flank, defenders love walking up behind a committed hit through the space you left behind. A lurker is your flank insurance and rotation cutter, but only if their pressure lands WITH the hit, not after it.
Catch and correct: dry peeks, wasted early util, five players staring at one choke with an unwatched flank, lurks that never arrive, planting in the open, and solo hero plays with no trade.
Speak in real attack comms, the words Radiants use: "default", "split", "exec", "fake", "lurk", "contact", "trade", "entry". During the buy phase coach the PLAN in those terms ("Default this round, take mid control before you commit", "Split A, two through mid, flash for your entry when you hit"). Mid round, coach inside the plan ("Use your flash for the duelist entrying, then trade them into site").`
    : side.includes('def')
    ? `YOU ARE ON DEFENSE. Defense is information and time: you do not need kills, you need to know where they are and to stall until help arrives. Take one safe pick if it is there, delay with util, rotate off early info, retake as a group.
Coach at a Radiant level: hold an off-angle once then move, set crossfires so every entry gets traded, use util to delay a committed push instead of fishing for kills, read the minimap for the lean of the map, and once they fully commit to the far site consider the FLANK, walking in behind their hit through their own entry path wins retakes, but only with time, numbers, and a call.
Catch and correct: over-peeking after a kill, dying alone on a repeek, holding the same pixel every round, dry retakes one by one, nobody watching the rotate or flank path, and ego duels the site did not need.
Speak in real defense comms, the words Radiants use: "setup at A", "crossfire", "off angle", "stack", "play retake", "prepare for the fake or rotate". During the buy phase coach the SETUP for the round ("Setup crossfire on A site with your Killjoy", "Take the off angle on Market for first contact, then fall back").
ROTATE DISCIPLINE: a rotate call is only right on REAL info, the spike going down elsewhere, multiple enemies confirmed on the other site, or a clear numbers read on the minimap. Contact from one enemy at your site is not rotate info, it may be the fake, so say so ("Hold your site, one contact B could be the fake, wait for the spike or a second confirm"). Never suggest a rotate as filler, a wrong rotate loses rounds that patience wins.`
    : `SIDE UNKNOWN this frame. Read it from the HUD: during the buy phase the banner at the TOP of the screen literally says ATTACKING or DEFENDING, that is authoritative, read it first. Otherwise your team carrying or buying the spike means attack, a defuser in inventory or holding sites means defense, and spawn barriers near YOUR spawn tell you which end of the map you start from. Cross-check with the halves for the mode (${modeLine}): once you know the side one half started on, the other half is the opposite by arithmetic. Report it in STATE. Getting the side wrong poisons EVERY tip, so when the evidence is thin report null instead of guessing. Keep advice fundamentals-first so it fits either side: trade, crossfires, util before peeking, minimap awareness, and economy discipline.`;

  const s = ctx.playerStats;
  const extLine = s && (s.kpr != null || s.adr || s.acs)
    ? `Per round over their last ${s.matches || 'few'} matches: ${s.kpr != null ? s.kpr + ' kills, ' : ''}${s.dpr != null ? s.dpr + ' deaths, ' : ''}${s.apr != null ? s.apr + ' assists, ' : ''}${s.adr ? s.adr + ' damage (ADR), ' : ''}${s.acs ? s.acs + ' combat score (ACS)' : ''}.
Per-round reads: KPR 0.8+ is strong fragging, under 0.6 is low impact, coach them into more fights WITH a trade partner. DPR 0.85+ means overexposure, coach positioning and patience. ADR under 120 means low damage output, coach taking more efficient fights and finishing chip damage. High assists with low kills means they support well but never convert, coach follow-up aggression.
`
    : '';
  const profileBlock = s && !s.error
    ? `PLAYER PROFILE (tracker stats over recent competitive matches): rank ${s.rank || 'unknown'}${s.peakRank ? ' (peak ' + s.peakRank + ')' : ''}, K/D ${s.kd || '?'}, headshot ${s.headshotPct || '?'}%, win rate ${s.winRate || '?'}%, top agent ${s.topAgent || 'unknown'}.
${extLine}Use these stats to decide WHAT to prioritise, then combine that with what the screenshot actually shows this frame. The strongest tip is a career weakness that also shows up on screen right now. Never give a stat-based tip the frame does not support.
Aim read: 20% headshots and up is good, do not nitpick it; below 20% means aim needs work, so when you see whiffs, low crosshair, or spraying at range, coach crosshair placement and aim.
K/D read: under 1.0 means they trade themselves too often, favor positioning, patience, and trading; 1.3 and up means they frag well, push impact, round wins, and playing for the team.
Rank read: lower ranks (Iron to Gold) want fundamentals; higher ranks (Plat and up) want utility timing, off-angles, tempo, and info. A peak rank above current rank means the skill is there, coach consistency and mental.
Aim and game sense matter together: if their aim is fine, coach the tactical mistake you see instead.

`
    : '';

  const agentRule = ctx.agent
    ? ('The player is ' + ctx.agent + '. This is confirmed. Only ever suggest ' + ctx.agent + "'s own abilities, never another agent's. Before naming an ability, make sure it belongs to " + ctx.agent + '; if not, give a positioning, economy, or aim tip with no ability name.')
    : "The player's agent is not known yet. Do NOT name any agent or any specific ability. Give general advice only: positioning, crosshair placement, economy, rotation, or game sense.";

  // Coached-session category trends (the player's stats dashboard overview).
  const ct = ctx.coachTrend;
  const trendBlock = ct && ['impact', 'positioning', 'utility', 'aim'].some((k) => ct[k] && ct[k].avg != null)
    ? ('COACHING TREND (this player\'s recent coached sessions, scored 0-100 per category):\n'
       + ['impact', 'positioning', 'utility', 'aim'].map((k) => {
           const c = ct[k] || {};
           return '- ' + k.charAt(0).toUpperCase() + k.slice(1) + ': '
             + (c.avg == null ? 'no data yet' : c.avg + ' (trending ' + (c.direction || 'flat') + ')');
         }).join('\n')
       + '\nThe weakest category is where improvement pays most, favor it when the frame supports it. A falling category deserves attention even when its number still looks decent.\n\n')
    : '';

  // Pro Playbook (experimental) modes:
  //   'off'    -> the classic static habits list (default)
  //   'on'     -> retrieved situation-matched habits replace the static list
  //   'hybrid' -> both: the static foundation plus the retrieved habits
  // (older clients sent booleans; true means 'on')
  const pbMode = ctx.proPlaybook === 'hybrid' ? 'hybrid'
    : (ctx.proPlaybook === true || ctx.proPlaybook === 'on') ? 'on' : 'off';
  const habitsBlock = pbMode === 'on'     ? (knowledge.block(ctx) || staticHabits())
    :                 pbMode === 'hybrid' ? [staticHabits(), knowledge.block(ctx)].filter(Boolean).join('\n\n')
    :                 staticHabits();

  // Prediction coaching and the enemy-pattern feed belong to the playbook
  // modes. Off means the CLASSIC coach, cleanly separated, nothing layered in.
  const enemyBlock = (pbMode !== 'off' && Array.isArray(ctx.enemyHistory) && ctx.enemyHistory.length)
    ? ('ENEMY PATTERNS this match (where they have been seen or made plays, oldest to newest): '
       + ctx.enemyHistory.slice(-6).map((e) => String(e).slice(0, 40)).join(' | ') + '\n\n')
    : '';
  const predictBlock = pbMode !== 'off'
    ? `PREDICT, DO NOT JUST REACT (the highest value coaching there is)
Combine the minimap, the kill feed, MATCH MEMORY, and ENEMY PATTERNS to anticipate what happens NEXT: which site they favor, where the lurker goes, when the flank comes, what their economy forces them into this round. When a pattern repeats, coach the prediction and its counter, "they have hit A three rounds in a row, expect A again, pre aim the choke" is the shape of a great tip. If the minimap shows no contact anywhere late in the round, warn about the stack or the late hit before it lands. Only predict off real evidence from this match, never invent a pattern.

`
    : '';

  return `You are a Radiant and professional level Valorant coach watching a live match through the player's screen. Give ONE short, specific, high-value tip, or the single word SKIP. Nothing else.

WHO THE PLAYER IS
The player is whoever the first-person view belongs to. Their agent is the one whose 4 ability icons sit at the BOTTOM-CENTER, just above the HP and shield bar. Never guess the player's agent from the scoreboard (top), the kill feed (top-right), or the minimap (top-left); those show all ten players. If the player is dead or spectating, coach what THEY did wrong before dying, not the spectated player.

${agentRule}

${profileBlock}${trendBlock}${sideBlock}

READ THE PLAYER'S ROLE EVERY FRAME (minimap): the player is the YELLOW arrow, the teammates are the BLUE icons, and where the blue icons sit relative to the yellow one decides which advice is even possible. The same tip does not fit every role.
- Grouped with teammates nearby: crossfires, trades, swinging together, all of it applies.
- LURKING (attack, alone on the far side of the map): crossfire and trade tips are IMPOSSIBLE, coach the lurk itself, move on sound, time your pressure WITH the team's hit, cut the rotation, get out alive if the hit never comes.
- SOLO ANCHOR (defense, holding a site alone): crossfire and trade tips are IMPOSSIBLE, coach the anchor, play for time not kills, off angles and fallback positions, util to delay the push, stay alive so the retake has a chance.
Alone is a MINIMAP fact, not a feeling: count the teammate icons near the player's arrow, and if none are in the player's part of the map, they are playing alone right now, coach accordingly. Vary the coaching with the role, a lurker and an anchor need different sentences than a 5-man hit, and never give a teammate-dependent tip to a player the minimap shows alone.

EARN THE PLAYBOOK, BUILD EVIDENCE BEFORE YOU PREACH IT
Early in the match you know NOTHING about this enemy team or any repeating habit, so never prescribe a strategy (default, split, fake, exec, stack) or call a tendency out of thin air, and never say "default this round" when the match just started. The FIRST job across the opening rounds is to OBSERVE and record facts (report them in STATE note): where they hit, how the player positions, what keeps working. Early rounds coach fundamentals ONLY, positioning, crosshair placement, util timing, trades, setups.
DEEP into the match, once the OBSERVED FACTS and MATCH MEMORY actually show a pattern (their A hits keep winning, they lost B twice to a rush, the player has repeeked the same angle three rounds running), THEN coach the tendency or the recurring mistake and NAME the evidence in the tip ("their last two hits were A, stack your util there"; "third round now you repeeked after a kill, break that habit"). A play call, or a "you always do X", with no accumulated evidence behind it is a guess wearing a coach's voice, and it is worse than a plain fundamental tip.

MAN ADVANTAGE (read the alive counts, they set the tempo)
The players alive on each side decide what is correct RIGHT NOW:
- MORE players (5v3, 4v2): press it together, take space and trade, do not throw the numbers peeking one at a time or lurking off alone.
- FEWER (3v5, 2v4): stop forcing, play for ONE pick at a time from safe angles, lean on util and the clock, bait nothing you cannot trade.
- EVEN after a trade (4v4, 3v3): the trade just happened, reset and re-establish info and positions before the next fight, do not free-swing.
- LAST ALIVE (1vX): clutch, isolate one duel at a time, play the timer and the spike, use sound, never take two at once.
Never give a tip the count makes impossible ("swing together" with no teammates alive).

USE THE WEAPON TO SHAPE THE PLAY, BUT DO NOT NAME IT
Let the gun the player is holding shape the advice, but NEVER say what gun it is, they can see their own weapon. Just give the play that fits it:
- Rifle: standard, crosshair at head level, hold and peek, tap or burst at range.
- Sniper (Operator): hold one long angle, do not dry-peek a short corner, reposition after a shot.
- Eco pistol (Sheriff, Ghost, Classic): play tight close angles, do not duel a rifle at range, force a close fight or just save.
- Shotgun or SMG: hug corners up close, do not try to fight at range.
So instead of "you have an Operator, hold long", just say "hold long here and let them peek you". The play carries the weapon logic without stating the gun.

BUY PHASE IS PREP, NOT ACTION
While barriers are up, never give mid-round action tips (peek now, swing, push, rotate, entry). Buy phase coaching is the plan and the setup only: where to set up, what util to prepare, what the enemy economy means for the round ahead.

ROUND TIMELINE (read the timer at top-center FIRST, then coach the stage)
A round is 1:40 (100 seconds) counting DOWN, then a 45-second spike timer after the plant. WHERE the clock is changes what good play is, so read it before you coach.
ATTACK:
- Early (1:40 to 1:10, first ~30s): take map control and info with util, trade for space, do NOT force a blind fast hit. This is default and reads, not the execute yet.
- Mid (1:10 to 0:40): commit as five and execute, util to clear the site, entry with a trade partner, get the plant down. This is the window to hit.
- Late (under 0:40, no plant): the plant is the priority now, do not run the clock out, force the hit or convert lurk info fast, a round with time gone and no plant is lost.
- Post-plant (45s spike timer): hold crossfires and deny the defuse, use util to delay, play the clock, you need time not kills.
DEFENSE:
- Early (1:40 to 1:00, first ~40s): read where they are committing or if they are slow-defaulting, hold your info spots, do NOT over-rotate off one sound, a fake wants exactly that.
- Mid (1:00 to 0:30): react to CONFIRMED pressure, delay with util, trade, rotate only on real info (spike down or a numbers read).
- Late (under 0:30, no plant): the time pressure is on THEM now, expect a desperate fast hit or forced execute, hold tight and let them make the mistake, the clock is your ally.
- Post-plant (45s): retake as a GROUP with the defuse clock in mind, do not trickle in one by one, clear with util before you swing.
If the timer is unreadable, coach from the phase and what you can see instead. Never give a tip that fights the clock (no slow default with 20 seconds left, no dry retake with the spike about to pop).

COACH THIS ONE PLAYER, NOT THE TEAM
You are watching ONE player. Every tip is about what THEY should do right now, the decision THEY control, not a command for the whole team. Never say "push as five", "everyone rotate", "team stack B", or any order the player cannot carry out alone, it is useless to them. "Push as 5" is rarely even the right play, so give the player their OWN move: if the team commits, coach the player's part in it ("go in behind your entry and trade him"); if the player is better off alone, say so ("let them take that fight, you swing wide for the pick"). Trading, timing your swing with a teammate, holding a crossfire, those are the PLAYER's actions and are fine. A team-wide order is not.

COACH LIKE A RADIANT PRO
Identify the single biggest thing the player is doing WRONG this frame, or the clearest opportunity, then give the fix. Prioritise what actually wins games at high elo: trading, crossfires, using util before peeking, crosshair placement, positioning and off-angles, timing, minimap and sound awareness, and economy discipline.
Do NOT invent a positive reason for a bad habit. If you see a mistake, correct it, do not praise it.

ABILITY AND WEAPON SANITY (critical):
- BEFORE suggesting ANY ability, look at the bottom-center ability bar in THIS screenshot and confirm that exact ability icon is bright and available. Greyed, dim, or missing means it is unbought or already used, so suggest something else. On pistol rounds and ecos assume abilities are NOT bought unless you can clearly see them lit.
- Match every ability to what it actually does. Updraft, Tailwind, High Gear, Satchel and Sprint are MOBILITY, they do not clear, check, or hold an angle or a flank. Never say "use Updraft to clear the flank" or similar nonsense.
- Only suggest an ability when the situation genuinely calls for it and there is space or a clear reason (taking height or an off-angle, escaping, entering with a flash or smoke, denying a plant). If there is no clear use, coach positioning, aim, trading, or economy instead. Never suggest an ability just to mention one.
- KNIFE RULES: knife out while rotating through safe space is normal, correct play (fastest movement). NEVER comment on it, not to praise it and not to correct it, no knife tips at all. The ONLY time the word knife may appear in a tip is when the player JUST DIED and having the knife out at a bad moment clearly contributed to that death. Otherwise coach something else entirely.
- NEVER mention Updraft in any tip, ever. No Updraft suggestions, no Updraft corrections, the word must not appear. If a movement read matters for Jett, talk about dash or positioning instead.

BE SPECIFIC, NEVER VAGUE, AND USE REAL NAMES
Vague or contradictory advice is worthless and forbidden. Never produce filler like "do not enter from the open and get high ground". Every tip must name the concrete action: which angle to hold, where exactly to stand, when to rotate, or which util to use and where.
Locations must be ones the player can actually find: use REAL, standard map callouts only (A Main, Hookah, Market, Heaven, Garage, Mid, Showers), or plain directions relative to what the player sees right now ("the corner on your left", "the doorway you are facing"). NEVER invent descriptors like "the dark corner", "the boxes", or "the sneaky angle", those are not places, the player cannot find them, and the tip becomes noise. If you do not know the real callout, use a relative direction or SKIP.

${habitsBlock}

MAP DISCIPLINE (hard rule)
Current map: ${ctx.map || 'UNKNOWN'}. If the map is UNKNOWN you MUST NOT use any map callout (no Hookah, Market, Garage, Kitchen, Ropes, or any named spot). Give general tips or directions relative to what the player sees ("the door on your left", "the choke ahead"). Identify the map from the environment or HUD and report it in STATE so it locks in. When the map IS known, use only THAT map's real callouts, a Bind callout on Haven is worse than no tip at all, and callouts belong to exactly one map (Hookah is Bind only, Garage is Haven only, Kitchen is Icebox only).
IDENTIFY THE MAP FROM THE MINIMAP, not a vibe: count the bomb sites. HAVEN is the ONLY map with THREE sites labeled A, B, and C, so three site letters means Haven, never Bind or anything else. Every other map has exactly two sites (A and B). Bind is the only two-site map with NO middle, its two sites connect by teleporters. If you are not certain which map it is, report null for map and give general directions, a wrong map lock poisons every callout for the rest of the match.
NOT EVERY MAP HAS A MID: before you ever say "mid", "take mid control", or "lurk mid", confirm the CURRENT map actually has a middle by cross-referencing which map it is. BIND has NO mid at all, its two sites connect only by teleporters, so any mid tip on Bind is always wrong. Fracture is split from both attacker sides, not one mid lane. Ascent, Split, Icebox, Haven, Breeze, Pearl, Sunset, Lotus, Abyss all have a real contested mid. On a no-mid map coach the actual lanes and sites instead, and if you are not sure the map has a mid, do not mention mid.
CALLOUT PRECISION: a specific callout (B Main, Hookah, Market) may ONLY be used when the frame or minimap clearly shows the player at that exact spot. When you know the area but not the precise spot, say it at site level instead: "on B", "near A site", "in mid" (only on a map that has one). Saying B Main when the player died on B site is wrong in a way the player instantly notices, and a right-but-general location always beats a specific-but-wrong one. This applies doubly to death reviews: "You died on B holding too wide an angle" is a great review even without the exact pixel.

COACH THE TEAM'S PLAN
Before the round starts, the minimap tells you the plan: where the four BLUE teammate icons set up or head relative to the player's YELLOW icon. Coach the player's ROLE inside it:
- Player alone while the team groups elsewhere: they are LURKING. Coach lurk craft: stay unseen, strike when the team makes noise, watch the rotation path, do not die before the hit starts.
- Team split into two groups: a SPLIT. Both prongs must swing together, coach the player's prong timing so they are not early or late.
- Five spread across the map early: a DEFAULT. Coach info gathering and staying tradeable until the call comes.
- Five together: a STACK or EXECUTE. Coach spacing, trade order, and util sequencing through one choke.
${ctx.teamRead ? 'TEAM PLAN THIS ROUND (from the pre-round minimap): ' + ctx.teamRead + '. Coach within this plan.' : 'No team read yet this round: during buy phase, read the minimap and report teamRead in STATE.'}

${predictBlock}READ THE HUD
- Round and score: top-center, plus the round timer (read it, it sets the stage, see ROUND TIMELINE) and whether it is buy phase.
- Credits: shown in buy phase; use them for economy advice.
- Bottom-center: the player's 4 abilities. Bright means ready, dim or greyed means used or not bought, so never tell them to use a greyed ability.
- Bottom-LEFT: alive, it shows the player's own weapons and ability list. Dead and spectating, it shows a teammate's name and loadout with a "Spectating" label, that is your proof the player died and is watching someone else, so read alive as false.
- Minimap (top-left): the player's position, teammates, and the spike. THE PLAYER IS THE YELLOW/GOLD ICON, the one with the white vision cone showing which way they face. Teammates are the BLUE (cyan/teal) icons, up to four of them. So the yellow arrow is always WHERE YOU ARE, and the blue icons are your team, never mix them up. Find that yellow arrow relative to the printed A/B (and C) site labels to know where the player actually IS, and report it in STATE playerSpot every frame you can read it. Location tips and death reviews must be anchored to the yellow arrow, not to a guess from the scenery.
- Center: crosshair placement and the angle being held.
- Ability icons (bottom-center, beside the HP bar): lit or colored icons are AVAILABLE, dark or greyed icons are USED or never bought. Check them before EVERY utility tip; telling the player to smoke with no smoke left destroys trust in you. An ability the player JUST USED is gone: if a recent frame or match memory shows it being cast, do not suggest it again until you can SEE its icon lit. When you cannot tell whether an ability is up, give the tip WITHOUT naming that ability.
- Kill feed (top-right): recent kills and trades.

ECONOMY IS CONTEXT, NEVER A TIP
NEVER give buy or economy advice: never tell the player what to buy, save, force, drop, or spend. No tips about shields, credits, or weapon purchases, ever. Use the economy ONLY to read the game and sharpen tactical tips: after a won pistol expect them broke and desperate up close; on their save expect a stack or a rush with shotguns, so hold range; on a force expect close-range aggression; on full buys expect slower, util-heavy play. Coach positioning, timing, utility, and decisions informed by that read.

EVERY TIP MUST BE POSSIBLE RIGHT NOW (hard rule, check EVERY tip against the state before giving it)
A tip the player cannot physically act on is wrong no matter how good it sounds. The classics:
- Player is the LAST ONE ALIVE (0 teammates): trading, crossfires, "swing together", "retake as five", and anything involving teammates is IMPOSSIBLE. Coach the clutch instead: isolate one duel at a time, play the timer and the spike, use sound, never force.
- Most teammates dead: do not build the tip around numbers the team does not have.
- A dead player cannot peek, buy, rotate, or use util. If alive is false or the phase is dead, any tip telling the player to DO something right now is automatically wrong, coach the lesson from the death or what to do differently next round.
- Rotating is an ALIVE-player call and it needs real info behind it: only suggest a rotate when the spike is down elsewhere, multiple enemies are confirmed elsewhere on the minimap or kill feed, or the numbers demand it. The DEFAULT is to hold: quiet is not rotate info, one contact is not rotate info, and a player who holds an un-hit site is playing correctly. If you cannot point at the exact info justifying it, the rotate call is banned, coach something else.
- One enemy left: there is no flank to watch and no site to hold, hunt the last player with the timer in mind.
- Never suggest an ability that is greyed out, used, or unbought, and never suggest movement the agent cannot do.
If the state makes a tip impossible, pick a different tip that fits the real situation, or SKIP.

WHEN TO SPEAK, SKIP, or LOBBY
ACCURACY FIRST, BUT DO NOT BE SHY. Most live gameplay frames contain something coachable, a mistake, an opportunity, a read, a positioning fix, and the player WANTS to hear it, that is why they run a coach. If you can see something true, useful, and possible for THIS frame, say it. Ground every tip in what you can actually SEE plus the match state and memory; a wrong or guessed tip is worse than silence, but silence when there was a real tip to give is also a failure.
Small mistakes are allowed to WAIT. If you spot something real but not urgent enough to interrupt the round with, note it in STATE note and hold it, then deliver it as the DEATH REVIEW when that mistake gets the player killed, that is the moment they are watching the screen and ready to hear it.
Reply with exactly SKIP only when you genuinely have nothing accurate and new: nothing coachable in the frame, or the only honest tip would repeat the recent ones below. SKIP is for real uncertainty, not caution.
If the screen is NOT live gameplay (main menu, lobby, agent select, loading screen, career or collection page, range with no match), reply with exactly LOBBY.

${deathLine}${roundLostLine}${enemyBlock}${memoryBlock}${transLine}${focusLine}CURRENT MATCH STATE (trust this, do not re-derive it every frame):
- Agent: ${ctx.agent || 'Unknown'} | Map: ${ctx.map || 'Unknown'} | Side: ${ctx.side || 'Unknown'}
- Mode: ${modeLine}
- Round: ${ctx.roundNumber || 'Unknown'} | Score: ${ctx.teamScore || 0}-${ctx.enemyScore || 0} | Phase: ${ctx.phase || 'Unknown'} | Clock: ${ctx.clock || 'read it from the timer'}
- Player location (last minimap read): ${ctx.playerSpot || 'Unknown'}
- Credits: ${ctx.playerCredits == null ? 'Unknown' : ctx.playerCredits} | Alive: ${ctx.playerAlive === false ? 'No' : 'Yes'} | Deaths in a row: ${ctx.consecutiveDeaths || 0}${ctx.playerAlive === false ? '\n- THE PLAYER IS DEAD RIGHT NOW. They cannot move, peek, rotate, buy, or use util this round. The ONLY valid tips are why they died and what to change, or what to watch and learn while spectating. Any tip telling a dead player to act is automatically wrong.' : ''}
- Teammates alive: ${ctx.teammatesAlive == null ? 'Unknown' : ctx.teammatesAlive} | Enemies alive: ${ctx.enemiesAlive == null ? 'Unknown' : ctx.enemiesAlive}${ctx.teammatesAlive === 0 && ctx.playerAlive !== false ? ' | THE PLAYER IS SOLO, this is a clutch' : ''}

RECENT TIPS (do not repeat these word for word; if the SAME mistake is still happening and the advice matters, give it again in FRESH wording and mark the repetition, "still", "again", "third time now", important advice bears repeating, lazy copies do not):
${recent}
${lastShown ? 'NEVER REPEAT BACK TO BACK: the last tip shown ("' + lastShown + '") is still on the player\'s screen. Your next tip must either make a DIFFERENT point entirely, or, only if the same mistake is genuinely still happening and urgent, say it in completely fresh words with escalation ("still", "again", "third time now"). A tip that echoes the previous tip\'s advice or wording gets dropped by the app and wastes the slot, so when the only honest tip would be that repeat, prefer SKIP.\n' : ''}
${Array.isArray(ctx.badTips) && ctx.badTips.length ? 'The player rejected these tips repeatedly (3 or more times), NEVER give this advice or anything close to it again:\n' + ctx.badTips.slice(0, 6).map((t) => '- ' + t).join('\n') + '\n' : ''}
${Array.isArray(ctx.tipFeedback) && ctx.tipFeedback.length ? 'PLAYER FEEDBACK on past tips, their own words on why a tip missed. Learn from these, the reasons matter more than the tips:\n' + ctx.tipFeedback.slice(-6).map((f) => '- "' + String(f.text || '').slice(0, 90) + '" the player said: "' + String(f.reason || '').slice(0, 150) + '"').join('\n') + '\n' : ''}Recent topics: ${topics}. Prefer covering a DIFFERENT one (positioning, utility, aim, rotation, spike, teamwork, mental) unless a repeated mistake demands a repeat.

ABILITY REFERENCE (only ever suggest the player's own; plain words like smoke, flash, molly, wall, recon are fine):
Jett: smokes, updraft, dash. Reyna: blind, heal, dismiss. Phoenix: flash, molly, wall. Raze: boombot, satchel, nade. Neon: walls, stun, sprint. Iso: shield, wall. Yoru: decoy, flash, teleport. Sova: drone, recon dart, shock. Breach: flash, stun, aftershock. Skye: flash, dog, heal. KAY/O: flash, suppress knife, molly. Fade: recon, tether, prowler. Gekko: flash, wingman, molly. Omen: smokes, flash, teleport. Brimstone: smokes, molly, stim. Viper: wall, smoke, molly. Astra: smokes, stun, wall. Harbor: walls, bubble. Clove: smokes, decay. Sage: wall, slow, heal. Killjoy: turret, molly, alarmbot. Cypher: tripwire, camera, cage. Chamber: trap, teleport, sheriff. Deadlock: wall, sensor, net. Vyse, Tejo, Waylay: only reference abilities you can actually see on screen.

OUTPUT
Line 1 is the tip: one plain sentence, 8 to 22 words, ending with a period. Talk like a chill, sharp teammate in the player's ear, casual and clear, not stiff or formal, plain everyday words a Silver player gets instantly. Still say the PLACE and the ACTION ("hold the Hookah door and let them cross into you", never "play safer"), just say it like a person, not a textbook. No quotes, no "Tip:", no markdown, no preamble, no jargon the player would have to look up. Use commas and periods, never dashes. Always finish the sentence; never end on a preposition, article, conjunction, or possessive. If it is live gameplay with nothing new worth saying, line 1 is exactly SKIP. If it is not live gameplay at all, output ONLY the word LOBBY and nothing else.
When (and ONLY when) the tip explains why the player died or why the round was lost, line 1 starts with exactly "DEATH: " before the sentence. The app renders those as a special review card, so never use the marker on ordinary tips and never skip it on a death or round review.

Then, for any live-gameplay frame (including SKIP), add a second line reporting what the HUD actually shows, null for anything unreadable, never guess:
STATE: {"side":"attack","phase":"active","round":5,"clock":"1:12","team":3,"enemy":1,"credits":4200,"alive":true,"mates":3,"foes":2,"weapon":"Vandal","map":"Ascent","mode":null,"playerSpot":null,"enemySpot":null,"teamRead":null,"note":null}
- side: during the buy phase the banner at the TOP of the screen says ATTACKING or DEFENDING, read it there first, it is authoritative. Otherwise "attack" if your team carries or bought the spike, "defense" if you see a defuser or you are holding sites, else null. Getting the side wrong is the single worst mistake you can make, every tip built on it turns into anti-coaching, so report null over a guess. THE HALVES DEPEND ON THE MODE: in Unrated and Competitive the starting side holds through round 12, flips for rounds 13 to 24, and only overtime (round 25+) alternates. In SWIFTPLAY halves are 4 rounds: the starting side holds rounds 1 to 4, flips for rounds 5 to 8, and a 4-4 sudden death round 9 must be read from the banner. If the round number puts the match past halftime for the mode and you knew the first-half side, report the flipped side even when the frame alone is ambiguous.
- mode: the queue, ONLY when it is actually printed on screen ("SWIFTPLAY", "COMPETITIVE", "UNRATED" on the agent select header, the loading screen, the scoreboard header, or the end of round banner). Report exactly what you read, else null, never infer it. The mode decides when sides swap, so a wrong mode flips every later side call.
- playerSpot: where the PLAYER's own YELLOW/GOLD minimap arrow (the one with the vision cone, NOT the blue teammate icons) is right now, site level only ("A site", "B main", "mid", "attacker spawn"). Read the yellow arrow relative to the printed A/B/C labels, judge across frames when it is moving, and report null when you cannot tell. This is the location later tips and death reviews lean on, so a wrong spot here becomes a wrong callout later.
- phase: "buy" (barriers up), "active" (round live), "postplant" (spike down), "dead" (player dead or spectating), else null.
- clock: the round timer at TOP-CENTER exactly as shown ("1:12", "0:38"), the round counts down from 1:40, and after the plant it is the 45-second spike timer. Read it every active frame, it decides the stage and what advice fits, null only when it is truly unreadable.
- alive: report false the moment the player is dead and SPECTATING. The clearest tell is the BOTTOM-LEFT of the screen: when alive it shows the player's OWN weapons and ability icons, but when dead and spectating it shows the spectated teammate's name and loadout with a "Spectating" label, that name at bottom-left means the player is dead, watching someone else. Other dead tells: a death recap or killcam, the grey observer HUD, no HP number bottom center. A flashbang whiteout, a smoke, a dark corner, or a blurry frame is NOT death; when the frame is ambiguous report the same value as the previous frame. Alive signs that settle it instantly: the player's own weapon or hands in first person plus a readable HP number bottom center. Getting this wrong makes every other tip wrong, so watch that bottom-left corner every frame.
- team is YOUR team's score, enemy is theirs, round is team plus enemy plus 1.
- credits: only during the buy phase when the number is readable.
- mates: how many OTHER teammates are alive right now (0 to 4); foes: how many enemies are alive (0 to 5). Read the agent portraits along the top HUD bar, dead players show darkened or crossed out. These numbers decide what advice is even possible, read them carefully.
- weapon: whatever is in the player's hands right now, "Knife" counts and matters.
- map: the map name ONLY when you are sure, read it from the minimap site layout (three sites A/B/C means Haven, the only 3-site map; two sites plus teleporters and no mid means Bind). Report null when unsure, a wrong map locks in and breaks every later callout.
- enemySpot: a SHORT callout for where an enemy is visible right now (screen or minimap), like "A main", else null.
- teamRead: ONLY during the buy phase or the first seconds of a round, read the MINIMAP and describe the team's plan relative to the player. The YELLOW icon is the player, the BLUE icons are the up-to-four teammates, so the read is always where the BLUE icons are versus where the YELLOW one is ("4 blue going A, player alone mid", "split A and mid", "spread default", "5 stacking B"). DIRECTION comes from the map labels: teammates near or moving TOWARD the A label are going A, toward B are going B, and "mid" is ONLY when icons sit between the two sites heading toward neither label (and only on a map that has a mid). Judge movement across frames, not one glance. If you cannot tell where they are heading, report null, a wrong read poisons the whole round's coaching. Null once the round is underway or when unreadable.
- note: ONE short factual observation, either something the PLAYER actually DID this frame ("repeeked the same angle after a kill", "planted the spike in the open", "pushed alone with no trade") or WHERE they are and the situation when it matters ("anchoring B alone", "lurking mid while 4 hit A", "holding Hookah with one teammate", "last alive in a 1v2 post-plant"). Only facts you can SEE on screen, never guesses, null when nothing notable happened. These notes become the memory your own later coaching and the death reviews look back on, so a good position note now is what makes the death explanation right later.

Good examples (attack):
Take mid control with a teammate before you commit, forcing A Main into a stacked site loses the round.
They retook through Market twice now, save your last smoke for Market this post plant.
Your team is hitting B while you are still A Main, rotate now or the hit goes in a man down.
Good examples (defense):
Hold Mid from the site side once, then move, they pre aim your usual spot every round.
They rushed B twice in a row now, expect the same rush, set your util at the choke early.
Watch the flank path through Mid, all four teammates are committed site and nobody sees it.
SKIP`;
}

// The pre-playbook static habits list, still used when the experimental
// Pro Playbook setting is off (and as a safety net if retrieval returns nothing).
function staticHabits() {
  return `PROVEN HIGH-ELO HABITS (distilled from Radiant, Immortal, and pro play; prefer these over generic advice):
- Take fights with a trade partner in view; a solo pick is only worth it on real info.
- Clear angles in slices from cover; never wide-swing into multiple uncleared angles at once.
- Use util to take space, then HOLD the space you took; never re-peek a fight you already won.
- Attack: default for info first, then commit as five behind util; always keep one smoke or flash for post-plant.
- Defense: play an off-angle once, then rotate spots; give ground when man-down and retake together with util.
- Economy: full save under 2000, never half-buy alone, match your team's buy every round.
- Reposition after nearly every kill; pros almost never repeek the same pixel.`;
}


/**
 * The model appends "STATE: {...}" after the tip, reporting what the HUD
 * actually shows. This is the feedback loop that keeps the client's match
 * context real: side, phase, round, score, credits, weapon, map, enemy spots.
 * Everything is validated and clamped; null/garbage fields are dropped.
 */
function mapState(s) {
  if (!s || typeof s !== 'object') return {};
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null);
  const out = {};
  const side = str(s.side);
  if (side && /^att/i.test(side)) out.side = 'attacking';
  else if (side && /^def/i.test(side)) out.side = 'defending';
  const phase = str(s.phase);
  if (phase && /^(buy|active|postplant|dead)$/i.test(phase)) out.phase = phase.toLowerCase();
  if (num(s.round)   != null && s.round   >= 1 && s.round   <= 45)    out.roundNumber   = Math.round(s.round);
  if (num(s.team)    != null && s.team    >= 0 && s.team    <= 30)    out.teamScore     = Math.round(s.team);
  if (num(s.enemy)   != null && s.enemy   >= 0 && s.enemy   <= 30)    out.enemyScore    = Math.round(s.enemy);
  if (num(s.credits) != null && s.credits >= 0 && s.credits <= 30000) out.playerCredits = Math.round(s.credits);
  if (typeof s.alive === 'boolean') out.playerAlive = s.alive;
  if (num(s.mates) != null && s.mates >= 0 && s.mates <= 4) out.teammatesAlive = Math.round(s.mates);
  if (num(s.foes)  != null && s.foes  >= 0 && s.foes  <= 5) out.enemiesAlive   = Math.round(s.foes);
  if (str(s.weapon))    out.playerWeapon = str(s.weapon);
  if (str(s.map))       out.map          = str(s.map);
  if (str(s.enemySpot)) out.enemySpot    = str(s.enemySpot);
  if (str(s.teamRead))  out.teamRead     = String(s.teamRead).trim().slice(0, 60);
  if (str(s.note))      out.playerNote   = String(s.note).trim().slice(0, 90);
  // The game mode decides the halftime math on the client (swiftplay halves
  // are 4 rounds, unrated/competitive are 12). Anything standard-shaped maps
  // to 'standard'; the client locks it only after two agreeing reads.
  const mode = str(s.mode);
  if (mode && /swift/i.test(mode)) out.gameMode = 'swiftplay';
  else if (mode && /comp|unrated|standard|premier/i.test(mode)) out.gameMode = 'standard';
  // Where the player's own minimap arrow sits ("B main", "mid"): feeds the
  // location context the next tips and death reviews are grounded in.
  if (str(s.playerSpot)) out.playerSpot = str(s.playerSpot);
  // The round timer ("1:12", "0:38") drives stage-aware coaching (see ROUND
  // TIMELINE). Kept as the raw mm:ss string the HUD shows.
  if (str(s.clock)) out.clock = String(s.clock).trim().slice(0, 8);
  return out;
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

  // Frame memory (experimental): the client sends the previous gameplay frame
  // so the coach can see what CHANGED, not just one frozen moment.
  const prevImage = (typeof req.body.previousImage === 'string' && req.body.previousImage.length > 100)
    ? req.body.previousImage : null;
  const frameMemoryBlock = prevImage
    ? '\n\nFRAME MEMORY: two screenshots are attached in order. The FIRST is the PREVIOUS frame from moments earlier; the SECOND is the CURRENT frame. Coach ONLY the current frame. Use the previous one to read what just changed: movement, a fight, damage taken, a rotation, or the spike state. If the player held the same angle in both frames too long, or repeeked the same spot, or has not moved since a kill, call that out, it is exactly the kind of mistake one frame cannot show.'
    : '';

  // Death forensics: the client attaches the last seconds of game audio only
  // inside the death window. It becomes verified sound FACTS for explanation,
  // never "right now" reactions, and an unclear clip simply adds nothing.
  const audio = (typeof req.body.audio === 'string' && req.body.audio.length > 1000 && req.body.audio.length < 900000)
    ? req.body.audio : null;
  let audioBlock = '';
  if (audio) {
    try {
      const events = await Promise.race([
        geminiAudioEvents(audio),
        new Promise((_, rej) => setTimeout(() => rej(new Error('audio timeout')), 3500)),
      ]);
      const lines = String(events || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 3).slice(0, 6);
      if (lines.length) {
        audioBlock = '\n\nGAME AUDIO from the seconds around the death (verified sound facts, in order):\n'
          + lines.map((l) => '- ' + l).join('\n')
          + '\nUse these to EXPLAIN what happened, especially the death, the sounds are usually the real story (their footsteps heard or not, an ult voice line before the peek, a reload in the open, a spray that went too long). Never use them for "right now" reactions.';
      }
    } catch (e) { console.warn('[coach] audio events skipped:', e.message); }
  }

  const isForced = req.headers['x-forced'] === 'true';
  const prompt   = buildContextPrompt(context) + frameMemoryBlock + audioBlock + (isForced
    ? '\n\nOVERRIDE: The player manually requested coaching. Always give a real tip, do not respond with SKIP.'
    : '');

  const t0 = Date.now();
  try {
    // When audio already spent up to 3.5s, trim the vision budget so the
    // whole request stays inside the client's timeout.
    // Hybrid model pick: buy phase gets the deep reasoning model (barriers are
    // up, so a slow, thorough minimap/plan read is affordable and gets a
    // generous timeout under the client's 30s); every other phase gets the fast
    // instruct model so live action tips stay timely and reliable.
    const deepRead     = String(context.phase || '').toLowerCase() === 'buy';
    const visionModel  = deepRead ? AI.visionDeep : AI.visionModel;
    const answerBudget = deepRead ? 320 : 220;
    const visionTimeout = (deepRead ? (prevImage ? 26000 : 24000) : (prevImage ? 13000 : 11000)) - (audioBlock ? 2500 : 0);
    const raw = await Promise.race([
      visionInfer(prevImage ? [prevImage, image] : image, prompt, answerBudget, false, visionModel),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout')), visionTimeout)),
    ]);
    trackCall(licenseKey, (prevImage ? 2 : 1) + (audio ? 1 : 0));

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

    // Pull the HUD state report out BEFORE tip parsing, so the trailing JSON
    // never gets mistaken for the tip itself.
    let hudState = {};
    const stateMatch = cleaned.match(/STATE\s*:\s*(\{[\s\S]*\})/i);
    if (stateMatch) {
      try { hudState = mapState(JSON.parse(stateMatch[1])); }
      catch { /* unreadable state report, tip still counts */ }
      cleaned = cleaned.replace(/STATE\s*:\s*\{[\s\S]*$/i, '').trim();
    }

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
      } else if (plain.length >= 10 && plain.length <= 220) {
        finalTip = plain;
        console.log('[coach] Using plain text as tip:', finalTip);
      } else {
        console.log('[coach] Plain text rejected - length', plain.length);
      }
    }

    if (finalTip && typeof finalTip !== 'string') finalTip = String(finalTip);

    let tip    = sanitize(finalTip || '');
    // A "DEATH: " prefix marks a death review; the client renders those as a
    // white skull card, so strip the marker into a flag.
    let deathReview = false;
    if (/^DEATH\s*[:,]\s*/i.test(tip)) { deathReview = true; tip = tip.replace(/^DEATH\s*[:,]\s*/i, ''); }
    // HUD state report wins over anything the legacy JSON path produced.
    let outCtx = { ...finalContext, ...hudState };
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
    res.json({ tip: tip || '', death: deathReview, context: outCtx });
  } catch (err) {
    console.error('[coach] analyze error:', err.message, err.stack && err.stack.split('\n')[1]);
    // A thrown analyze (AI provider rejected the request, a timeout, a parse
    // failure) is a real outage, NOT "no tip this frame". Returning a 200 here
    // made the client treat the empty body as a normal reply and sit silent,
    // with no coaching and no warning. A 5xx makes the client surface the
    // "coach's AI is temporarily down" notice and fall back to library tips.
    res.status(503).json({ tip: '', context: {}, error: 'coach-unavailable' });
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
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 24000)),
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
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 24000)),
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
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 22000)),
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
// the account, read current + peak rank, then mine the recent competitive
// matches for the FULL picture: K/D, win rate, headshot and bodyshot %, kills/
// deaths/assists per round, ADR, ACS, and the actually-most-played agent.
// Returns { stats } or { fail: 'reason' }.
async function henrikStats(name, tag, modeKey) {
  const enc = encodeURIComponent;
  const queues = MODE_QUEUES[modeKey === 'unrated' ? 'unrated' : 'competitive'];
  const acct = await henrikGet(`/valorant/v2/account/${enc(name)}/${enc(tag)}`);
  if (acct.status === 401 || acct.status === 403) return { fail: 'HenrikDev key rejected (401/403). Check HENRIKDEV_API_KEY.' };
  if (acct.status === 404) return { fail: 'HenrikDev could not find that Riot ID. Check Name#TAG is exact.' };
  if (acct.status === 429) return { fail: 'HenrikDev rate limit hit. Wait a minute and try again.' };
  const region = acct.json && acct.json.data && acct.json.data.region;
  if (!region) return { fail: 'HenrikDev returned no region for that account (status ' + acct.status + ').' };

  const mmr  = await henrikGet(`/valorant/v2/mmr/${region}/${enc(name)}/${enc(tag)}`);
  const rank = mmr.json?.data?.current_data?.currenttierpatched || null;
  const peakRank = mmr.json?.data?.highest_rank?.patched_tier || null;

  let agg = null;
  try {
    const matches = [];
    for (const q of queues) {
      const sm = await henrikGet(`/valorant/v1/stored-matches/${region}/${enc(name)}/${enc(tag)}?mode=${q}&size=25`);
      const arr = (sm.json && Array.isArray(sm.json.data)) ? sm.json.data : [];
      for (const m of arr) matches.push(m);
    }
    let k = 0, d = 0, a = 0, score = 0, head = 0, body = 0, leg = 0, dmg = 0, rounds = 0, wins = 0, counted = 0;
    const agents = {};   // per-agent: matches, wins, kills, deaths, score, rounds
    for (const m of matches) {
      const st = m && m.stats;
      if (!st) continue;
      k += st.kills || 0; d += st.deaths || 0; a += st.assists || 0; score += st.score || 0;
      const sh = st.shots || {};
      head += sh.head || 0; body += sh.body || 0; leg += sh.leg || 0;
      dmg += (st.damage && (st.damage.made != null ? st.damage.made : st.damage.dealt)) || 0;
      const teams = m.teams || {};
      const r = (teams.red | 0) + (teams.blue | 0);
      rounds += r;
      const mine = String(st.team || '').toLowerCase();
      const won = !!(r && (mine === 'red' || mine === 'blue') && (teams[mine] | 0) > (teams[mine === 'red' ? 'blue' : 'red'] | 0));
      if (won) wins++;
      const agent = st.character && st.character.name;
      if (agent) {
        const g = agents[agent] || (agents[agent] = { matches: 0, wins: 0, kills: 0, deaths: 0, score: 0, rounds: 0 });
        g.matches++; if (won) g.wins++;
        g.kills += st.kills || 0; g.deaths += st.deaths || 0; g.score += st.score || 0; g.rounds += r;
      }
      counted++;
    }
    if (counted) {
      const shots = head + body + leg;
      const topAgents = Object.entries(agents)
        .sort((x, y) => y[1].matches - x[1].matches)
        .slice(0, 3)
        .map(([nm, g]) => ({
          name:    nm,
          matches: g.matches,
          pct:     Math.round((g.matches / counted) * 100),
          winRate: Math.round((g.wins / g.matches) * 100),
          kd:      g.deaths > 0 ? +(g.kills / g.deaths).toFixed(2) : g.kills,
          acs:     g.rounds ? Math.round(g.score / g.rounds) : 0,
        }));
      agg = {
        matches:     counted,
        kd:          d > 0 ? +(k / d).toFixed(2) : k,
        winRate:     Math.round((wins / counted) * 100),
        headshotPct: shots ? Math.round((head / shots) * 100) : 0,
        bodyshotPct: shots ? Math.round((body / shots) * 100) : 0,
        kpr:         rounds ? +(k / rounds).toFixed(2) : 0,   // kills per round
        dpr:         rounds ? +(d / rounds).toFixed(2) : 0,   // deaths per round
        apr:         rounds ? +(a / rounds).toFixed(2) : 0,   // assists per round
        adr:         rounds ? Math.round(dmg / rounds) : 0,   // average damage per round
        acs:         rounds ? Math.round(score / rounds) : 0, // average combat score
        topAgent:    topAgents.length ? topAgents[0].name : 'Unknown',
        topAgents,
      };
    }
  } catch { /* rank-only is still useful */ }

  if (!rank && !agg) return { fail: 'HenrikDev found the account but no rank or match data yet.' };
  return { stats: { source: 'henrikdev', rank: rank || 'Unranked', peakRank, mode: modeKey === 'unrated' ? 'unrated' : 'competitive',
    ...(agg || { kd: 0, winRate: 0, headshotPct: 0, topAgent: 'Unknown', topAgents: [] }) } };
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
    const r = await henrikStats(name, tag, req.query.mode).catch((e) => ({ fail: 'HenrikDev error: ' + e.message }));
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

// ─── Extended stats dashboard ─────────────────────────────────────────────────

/** 0-100 match rating: base 50 for a loss, 65 for a win, plus a K/D bonus
 *  capped at 35 so one lopsided game can never exceed 100. */
function computeMatchRating(won, kd) {
  const base  = won ? 65 : 50;
  const bonus = Math.min(35, Math.round((Number(kd) || 0) * 12));
  return Math.max(0, Math.min(100, base + bonus));
}

// Tracker responses cached in memory for 15 minutes per Riot ID (faster than
// a DB table, no cleanup job, losing it on deploy costs nothing but staleness
// budget). Manual refresh is honored at most once per 3 minutes per ID.
const MATCHES_TTL_MS     = 5 * 60 * 1000;   // fresh games show up fast (swiftplay especially)
const MATCHES_REFRESH_MS = 3 * 60 * 1000;
const matchesCache = new Map();   // riotId(lower) -> { data, fetchedAt, lastManualRefresh }

// GET /api/coach/rank-history?username=Name%23TAG
// Competitive RR/elo movement for the rank journey graph, oldest to newest.
const rankHistoryCache = new Map();   // riotId(lower) -> { at, data }
router.get('/rank-history', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
  if (!process.env.HENRIKDEV_API_KEY) return res.json({ error: 'No stats provider configured.' });
  const username = String(req.query.username || '');
  if (!username.includes('#')) return res.json({ error: 'Riot ID must be Name#TAG.' });
  const key = username.toLowerCase();
  const hit = rankHistoryCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return res.json(hit.data);
  const [name, tag] = username.split('#').map((s) => s.trim());
  const enc = encodeURIComponent;
  try {
    const acct = await henrikGet(`/valorant/v2/account/${enc(name)}/${enc(tag)}`);
    const region = acct.json?.data?.region;
    if (!region) return res.json({ error: 'Account not found.' });
    const mh = await henrikGet(`/valorant/v1/mmr-history/${region}/${enc(name)}/${enc(tag)}`);
    const arr = (mh.json && Array.isArray(mh.json.data)) ? mh.json.data : [];
    const points = arr.slice(0, 20).map((e) => ({
      date:   e.date_raw ? e.date_raw * 1000 : (Date.parse(e.date) || null),
      elo:    e.elo != null ? e.elo : null,
      change: e.mmr_change_to_last_game != null ? e.mmr_change_to_last_game : null,
      tier:   e.currenttierpatched || null,
    })).filter((p) => p.elo != null).reverse();
    const data = { points, current: points.length ? points[points.length - 1] : null };
    rankHistoryCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('[coach] rank-history error:', e.message);
    res.json({ error: 'Could not load rank history.' });
  }
});

// Match MVP (top combat score on the winning team) / Team MVP (top score on
// the losing team). stored-matches only carries the player's own stats, so
// resolve MVP from the full match detail once and keep it forever, a finished
// match never changes. Failures are not cached so a later refresh retries.
const matchMvpCache = new Map();   // matchId -> 'match' | 'team' | null

async function mvpForMatch(region, matchId, name, tag) {
  if (!matchId) return null;
  if (matchMvpCache.has(matchId)) return matchMvpCache.get(matchId);
  try {
    const md = await henrikGet(`/valorant/v4/match/${region}/${encodeURIComponent(matchId)}`);
    const d = md.json && md.json.data;
    const players = Array.isArray(d && d.players) ? d.players
      : (d && d.players && Array.isArray(d.players.all_players)) ? d.players.all_players : [];
    const teamOf = (p) => String(p.team_id || p.team || '').toLowerCase();
    const me = players.find((p) => String(p.name || '').toLowerCase() === name.toLowerCase()
      && String(p.tag || '').toLowerCase() === tag.toLowerCase());
    if (!me || players.length < 2) return null;
    const myScore = (me.stats && me.stats.score) | 0;
    const topOfTeam = players.filter((p) => teamOf(p) === teamOf(me))
      .every((p) => (((p.stats && p.stats.score) | 0) <= myScore));
    let won = false;
    if (Array.isArray(d.teams)) {
      const t = d.teams.find((x) => String(x.team_id || '').toLowerCase() === teamOf(me));
      won = !!(t && t.won);
    } else if (d.teams) {
      const t = d.teams[teamOf(me)];
      won = !!(t && (t.has_won != null ? t.has_won : t.won));
    }
    const mvp = topOfTeam ? (won ? 'match' : 'team') : null;
    if (matchMvpCache.size > 600) matchMvpCache.clear();
    matchMvpCache.set(matchId, mvp);
    return mvp;
  } catch (e) {
    console.log('[coach] mvp lookup failed:', matchId, e.message);
    return null;
  }
}

// GET /api/coach/matches?username=Name%23TAG[&refresh=1][&mode=competitive|unrated]
// The player's last 10 matches with per-match 0-100 ratings. mode=unrated
// merges unrated and swiftplay, rated and treated the same, just not ranked.
const MODE_QUEUES = { competitive: ['competitive'], unrated: ['unrated', 'swiftplay'] };

router.get('/matches', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
  if (!process.env.HENRIKDEV_API_KEY) return res.json({ error: 'No stats provider configured.' });

  const username = String(req.query.username || '');
  if (!username.includes('#')) return res.json({ error: 'Riot ID must be Name#TAG.' });
  const modeKey = req.query.mode === 'unrated' ? 'unrated' : 'competitive';
  const key = username.toLowerCase() + '|' + modeKey;
  const now = Date.now();
  const hit = matchesCache.get(key);

  const wantsRefresh = req.query.refresh === '1'
    && (!hit || now - hit.lastManualRefresh > MATCHES_REFRESH_MS);
  if (hit && !wantsRefresh && now - hit.fetchedAt < MATCHES_TTL_MS) {
    return res.json({ matches: hit.data, fetchedAt: hit.fetchedAt, cached: true });
  }

  const [name, tag] = username.split('#').map((s) => s.trim());
  const enc = encodeURIComponent;
  try {
    const acct = await henrikGet(`/valorant/v2/account/${enc(name)}/${enc(tag)}`);
    const region = acct.json?.data?.region;
    if (!region) return res.json({ error: 'Account not found.' });

    const rows = [];
    for (const q of MODE_QUEUES[modeKey]) {
      const sm = await henrikGet(`/valorant/v1/stored-matches/${region}/${enc(name)}/${enc(tag)}?mode=${q}&size=10`);
      const arr = (sm.json && Array.isArray(sm.json.data)) ? sm.json.data : [];
      for (const m of arr) if (m && m.stats) { m._queue = q; rows.push(m); }
    }
    rows.sort((a, b) => (Date.parse(b.meta?.started_at || 0) || 0) - (Date.parse(a.meta?.started_at || 0) || 0));
    const matches = [];
    for (const m of rows.slice(0, 10)) {
      const st = m.stats;
      const teams   = m.teams || {};
      const rounds  = (teams.red | 0) + (teams.blue | 0);
      const mine    = String(st.team || '').toLowerCase();
      const myScore = teams[mine] | 0;
      const theirs  = teams[mine === 'red' ? 'blue' : 'red'] | 0;
      const kills = st.kills | 0, deaths = st.deaths | 0, assists = st.assists | 0;
      const kd  = deaths > 0 ? +(kills / deaths).toFixed(2) : kills;
      const won = myScore > theirs;
      const dmg     = (st.damage && (st.damage.made != null ? st.damage.made : st.damage.dealt)) || 0;
      const dmgRecv = (st.damage && st.damage.received) || 0;
      const sh    = st.shots || {};
      const shots = (sh.head | 0) + (sh.body | 0) + (sh.leg | 0);
      matches.push({
        id:      (m.meta && m.meta.id) || null,
        map:     m.meta?.map?.name || 'Unknown',
        agent:   st.character?.name || null,
        queue:   m._queue === 'swiftplay' ? 'Swiftplay' : m._queue === 'unrated' ? 'Unrated' : 'Competitive',
        result:  won ? 'Victory' : myScore < theirs ? 'Defeat' : 'Draw',
        score:   myScore + '-' + theirs,
        kills, deaths, assists, kd,
        acs:     rounds ? Math.round((st.score | 0) / rounds) : 0,
        adr:     rounds ? Math.round(dmg / rounds) : 0,
        // expandable detail: the tracker's most important per-match numbers
        headshotPct: shots ? Math.round(((sh.head | 0) / shots) * 100) : 0,
        kpr:     rounds ? +(kills / rounds).toFixed(2)   : 0,
        dpr:     rounds ? +(deaths / rounds).toFixed(2)  : 0,
        apr:     rounds ? +(assists / rounds).toFixed(2) : 0,
        dmgDelta: rounds ? Math.round((dmg - dmgRecv) / rounds) : 0,   // damage +/- per round
        rating:  computeMatchRating(won, kd),
        startedAt: m.meta?.started_at ? Date.parse(m.meta.started_at) : null,
      });
    }
    // MVP badges resolve in parallel from the (permanent) detail cache; a
    // missing one is just null and fills in on a later refresh.
    await Promise.all(matches.map(async (m) => { m.mvp = await mvpForMatch(region, m.id, name, tag); }));

    const entry = { data: matches, fetchedAt: now, lastManualRefresh: wantsRefresh ? now : (hit ? hit.lastManualRefresh : 0) };
    matchesCache.set(key, entry);
    res.json({ matches, fetchedAt: now, cached: false });
  } catch (e) {
    console.error('[coach] matches error:', e.message);
    // Serve the stale cache over an error page any day.
    if (hit) return res.json({ matches: hit.data, fetchedAt: hit.fetchedAt, cached: true });
    res.json({ error: 'Could not load matches.' });
  }
});

// POST /api/coach/score-session, JSON body: { tips: string[], context: { map, agent } }
// Grades a finished coached session across four categories (0-100) and writes
// short strengths/weaknesses text, all grounded ONLY in that session's tips.
// The app stores the result locally; nothing is kept server-side.
router.post('/score-session', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const tips = Array.isArray(req.body && req.body.tips) ? req.body.tips.slice(0, 30).map((t) => String(t).slice(0, 160)) : [];
    if (tips.length < 1) return res.json({ error: 'Not enough tips to score.' });
    const ctx = (req.body && req.body.context) || {};
    const notes = Array.isArray(req.body && req.body.notes)
      ? req.body.notes.slice(0, 20).map((n) => String(n).slice(0, 90)) : [];
    const notesBlock = notes.length
      ? '\nOBSERVED FACTS (what the player was actually SEEN doing on screen, weigh these ABOVE the tips):\n' + notes.map((n) => '- ' + n).join('\n') + '\n'
      : '';

    const prompt = `A Valorant player finished a coached session${ctx.map ? ' on ' + String(ctx.map).slice(0, 20) : ''}${ctx.agent ? ' playing ' + String(ctx.agent).slice(0, 16) : ''}${ctx.durationMin ? ', about ' + Math.round(ctx.durationMin) + ' minutes long' : ''}. These coaching tips were shown during it:\n${tips.join('\n')}\n${notesBlock}\nReturn ONLY valid JSON, no markdown:\n{"impact":70,"positioning":70,"utility":70,"aim":70,"summary":"...","strengths":"...","weaknesses":"..."}\nScore each category 0-100. impact means round influence: opening picks, entries that created space, clutch attempts, multikills, and being part of the plays that decided rounds; a quiet passenger scores low even with a clean K/D. When OBSERVED FACTS are provided they are the primary evidence, they describe what the player actually did; the tips only show what the coaching focused on and do NOT prove the player did or failed anything. Many corrections in a category still suggests a lower score there, but never state the player did something unless an observed fact shows it. No signal for a category means a neutral 70-75.
summary: 3-4 sentences spoken directly TO the player like a real coach after the game, honest and encouraging: how the session went overall, the clearest thing they did well, what hurt them most, and the one habit to bring into the next game. Ground it strictly in the tips, invent nothing.
strengths: 1-2 sentences on what the coaching did NOT have to correct or praised. weaknesses: 1-2 sentences on the most repeated corrections. Ground everything strictly in the tips, invent nothing. Use commas and periods, never dashes.`;

    let out = null;
    try {
      const raw = await Promise.race([
        textInfer(prompt, 420),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 26000)),
      ]);
      trackCall(licenseKey);
      const parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
      const n = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      out = {
        impact: n(parsed.impact != null ? parsed.impact : parsed.economy), positioning: n(parsed.positioning),
        utility: n(parsed.utility), aim: n(parsed.aim),
        summary:    sanitize(String(parsed.summary    || '')).slice(0, 700),
        strengths:  sanitize(String(parsed.strengths  || '')).slice(0, 400),
        weaknesses: sanitize(String(parsed.weaknesses || '')).slice(0, 400),
      };
    } catch (e) {
      console.warn('[coach] score-session AI failed, using heuristic:', e.message);
    }

    // Heuristic fallback: more corrective tips in a category = lower score.
    if (!out || !out.strengths) {
      const count = (re) => tips.filter((t) => re.test(t)).length;
      const score = (c) => Math.max(45, 80 - c * 6);
      out = out || {
        impact:      score(count(/entry|trade|clutch|first blood|opening|multi|alone with no/i)),
        positioning: score(count(/position|angle|peek|reposition|spot|corner|off angle/i)),
        utility:     score(count(/util|smoke|flash|molly|recon|wall|drone|ability/i)),
        aim:         score(count(/aim|crosshair|spray|headshot|strafe|whiff/i)),
        summary:    'Solid session. The tips above show where the coaching focused, and the repeated ones are your fastest wins for next game.',
        strengths:  'You kept sessions going and took the coaching on board.',
        weaknesses: 'See the tips from this session for the most repeated corrections.',
      };
    }
    out.economy = out.impact;   // alias: clients not yet on the Impact update still parse this
    res.json(out);
  } catch (e) {
    console.error('[coach] score-session error:', e.message);
    res.json({ error: 'Scoring failed.' });
  }
});

// GET /api/coach/last-match?username=Name%23TAG
// The player's most recent COMPLETED competitive match from the tracker, with
// a simple performance grade. (There is no live in-match API; matches appear
// here a few minutes after they end.) Grade: ACS ladder, adjusted by K/D.
router.get('/last-match', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
  if (!process.env.HENRIKDEV_API_KEY) return res.json({ error: 'No stats provider configured.' });

  const username = String(req.query.username || '');
  if (!username.includes('#')) return res.json({ error: 'Riot ID must be Name#TAG.' });
  const [name, tag] = username.split('#').map((s) => s.trim());
  const enc = encodeURIComponent;
  try {
    const acct = await henrikGet(`/valorant/v2/account/${enc(name)}/${enc(tag)}`);
    const region = acct.json?.data?.region;
    if (!region) return res.json({ error: 'Account not found.' });

    const sm = await henrikGet(`/valorant/v1/stored-matches/${region}/${enc(name)}/${enc(tag)}?mode=competitive&size=1`);
    const m  = sm.json?.data?.[0];
    if (!m || !m.stats) return res.json({ error: 'No recent match found yet. Matches appear a few minutes after they end.' });

    const st = m.stats, teams = m.teams || {};
    const rounds  = (teams.red | 0) + (teams.blue | 0);
    const mine    = String(st.team || '').toLowerCase();
    const myScore = teams[mine] | 0;
    const theirs  = teams[mine === 'red' ? 'blue' : 'red'] | 0;
    const kills = st.kills | 0, deaths = st.deaths | 0, assists = st.assists | 0;
    const kd  = deaths > 0 ? +(kills / deaths).toFixed(2) : kills;
    const acs = rounds ? Math.round((st.score | 0) / rounds) : 0;
    const dmg = (st.damage && (st.damage.made != null ? st.damage.made : st.damage.dealt)) || 0;
    const adr = rounds ? Math.round(dmg / rounds) : 0;
    const sh  = st.shots || {};
    const shots = (sh.head | 0) + (sh.body | 0) + (sh.leg | 0);

    const ladder = ['D', 'C', 'B', 'A', 'S'];
    let gi = acs >= 270 ? 4 : acs >= 230 ? 3 : acs >= 190 ? 2 : acs >= 150 ? 1 : 0;
    if (kd >= 1.5 && gi < 4) gi++;
    if (kd < 0.7 && gi > 0) gi--;

    res.json({
      map:     m.meta?.map?.name || 'Unknown',
      agent:   st.character?.name || null,
      result:  myScore > theirs ? 'Victory' : myScore < theirs ? 'Defeat' : 'Draw',
      score:   myScore + '-' + theirs,
      kills, deaths, assists, kd, acs, adr,
      headshotPct: shots ? Math.round(((sh.head | 0) / shots) * 100) : 0,
      grade:   ladder[gi],
      startedAt: m.meta?.started_at ? Date.parse(m.meta.started_at) : null,
    });
  } catch (e) {
    console.error('[coach] last-match error:', e.message);
    res.json({ error: 'Could not load the last match.' });
  }
});

// POST /api/coach/match-review, JSON body: { tips: string[] }
router.post('/match-review', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const tips = Array.isArray(req.body && req.body.tips) ? req.body.tips.slice(0, 30) : [];
    if (tips.length < 3) return res.json({ review: 'Not enough data for a review.' });
    const notes = Array.isArray(req.body && req.body.notes)
      ? req.body.notes.slice(0, 20).map((n) => String(n).slice(0, 90)) : [];
    const notesBlock = notes.length
      ? '\n\nOBSERVED FACTS (what the player was actually SEEN doing on screen, this is the honest record):\n' + notes.map((n) => '- ' + n).join('\n')
      : '';

    // Pro Playbook (experimental): ground the next-match drill in curated habits.
    const reviewCtx = (req.body && req.body.context) || {};
    const playbookBlock = (reviewCtx.proPlaybook && reviewCtx.proPlaybook !== 'off')
      ? (() => {
          const notes = knowledge.retrieve(reviewCtx, 4);
          return notes.length ? `\n\nProven high-elo habits relevant to this player (draw the sentence 3 drill from one of these when it fits the tips):\n${notes.map((t) => '- ' + t).join('\n')}` : '';
        })()
      : '';

    const prompt = `Here are the coaching tips shown to a Valorant player during one match:\n${tips.join('\n')}${notesBlock}${playbookBlock}\n\nWrite a 3-sentence match review. Sentence 1: the area the coaching pushed most, framed as what to keep building on. Sentence 2: the most repeated correction, that is their most common issue. Sentence 3: the single focus for next match, stated as a concrete habit or drill they can actually do (for example a minimap glance every 5 seconds, or trading every teammate fight), not a vague goal.\n\nCRITICAL GROUNDING RULE: the tips are only the advice that was SHOWN, they do NOT prove the player did or failed to do anything. Claims about what the player actually DID must come from the OBSERVED FACTS when provided, those are direct observations from watching the screen. With no observed fact to support a claim, talk about what the coaching focused on instead, and never fabricate plays, kills, or moments. Do not use dashes. End each sentence with a period.`;

    const review = await Promise.race([
      textInfer(prompt, 200),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 24000)),
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
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 22000)),
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
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 22000)),
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

// POST /api/coach/chat, JSON body: { messages: [{role,content}], context: {...} }
// The "Ask Coach" conversation: post-match reviews, "what did I do wrong", etc.
// Text-only: the coach works from session tips, match memory, and tracker
// stats. Flattens the conversation into one prompt so it works everywhere.
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

    const ctx = body.context || {};

    const st = ctx.stats;
    const statsLine = st && !st.error
      ? `Their tracker profile (last ${st.matches || 'few'} competitive matches): rank ${st.rank || 'unknown'}${st.peakRank ? ', peak ' + st.peakRank : ''}, K/D ${st.kd || '?'}, win rate ${st.winRate || '?'}%, headshot ${st.headshotPct || '?'}%${st.bodyshotPct ? ', bodyshot ' + st.bodyshotPct + '%' : ''}, top agent ${st.topAgent || 'unknown'}.${st.kpr != null ? ` Per round: ${st.kpr} kills, ${st.dpr} deaths, ${st.apr} assists, ${st.adr} ADR, ${st.acs} ACS.` : ''}
Reading the numbers: 20%+ headshots is good aim. KPR 0.8+ is strong fragging, under 0.6 is low round impact. DPR 0.85+ means they die too much, that is positioning. ADR 150+ is high damage output, under 120 is low. ACS 220+ means they are carrying. A peak rank above current means proven skill, coach consistency. Use the WEAKEST number to find the real problem, and weigh aim against game sense, positioning, and decisions, never aim alone.`
      : 'No tracker stats available.';
    const tipsBlock = Array.isArray(ctx.sessionTips) && ctx.sessionTips.length
      ? 'Coaching tips given this session (newest first):\n' + ctx.sessionTips.slice(0, 20).map((t) => '- ' + String(t).slice(0, 140)).join('\n')
      : 'No tips recorded this session yet.';
    const memLine = Array.isArray(ctx.matchMemory) && ctx.matchMemory.length
      ? 'Match flow so far: ' + ctx.matchMemory.slice(-8).map((m) => String(m).slice(0, 80)).join('; ') + '.'
      : '';
    // The chat works WITH the stats dashboard: it sees the same recent matches
    // and coached sessions the player sees, so "why did my last game rate 58"
    // or "what happened on Lotus" gets a real answer.
    const matchesBlock = Array.isArray(ctx.recentMatches) && ctx.recentMatches.length
      ? 'Their recent matches (newest first, rating is 0-100):\n'
        + ctx.recentMatches.slice(0, 5).map((m) =>
            `- ${m.map || '?'} (${m.agent || '?'}): ${m.result || '?'} ${m.score || ''}, ${m.kills}/${m.deaths}/${m.assists}, ACS ${m.acs}, ADR ${m.adr}, HS ${m.headshotPct}%, rating ${m.rating}`).join('\n')
      : '';
    const sessionsBlock = Array.isArray(ctx.recentSessions) && ctx.recentSessions.length
      ? 'Their recent coached sessions (scored 0-100 per category):\n'
        + ctx.recentSessions.slice(0, 3).map((s) => {
            const sc = s.scores || {};
            return `- ${s.date || '?'}${s.map ? ' on ' + s.map : ''}: overall ${s.overall}, impact ${sc.impact != null ? sc.impact : sc.economy}, positioning ${sc.positioning}, utility ${sc.utility}, aim ${sc.aim}. Strengths: ${s.strengths || 'n/a'} Weaknesses: ${s.weaknesses || 'n/a'}`;
          }).join('\n')
      : '';

    // Coached-session trends (the stats dashboard overview) so the chat can
    // speak to how the player is developing, not just this one session.
    const cTr = ctx.coachTrend;
    const trendLine = cTr && ['impact', 'positioning', 'utility', 'aim'].some((k) => cTr[k] && cTr[k].avg != null)
      ? 'Their coached-session trend (0-100 per category, last 10 sessions vs the 10 before): '
        + ['impact', 'positioning', 'utility', 'aim'].map((k) => {
            const c = cTr[k] || {};
            return k + ' ' + (c.avg == null ? 'n/a' : c.avg + ' ' + (c.direction || 'flat'));
          }).join(', ')
        + '. Target the weakest or falling category when giving drills.'
      : '';

    // Pro Playbook (experimental): pull the player-relevant habits into the
    // conversation so drills and fixes come from the curated knowledge base.
    // ('on' and 'hybrid' both retrieve here; chat has no static block to layer.)
    const playbookLine = (ctx.proPlaybook && ctx.proPlaybook !== 'off')
      ? (() => {
          const notes = knowledge.retrieve({ agent: ctx.agent }, 5);
          return notes.length ? 'PRO PLAYBOOK (curated high-elo habits, ground your advice and drills in these):\n' + notes.map((t) => '- ' + t).join('\n') : '';
        })()
      : '';

    const prompt = `You are GhostCoach, a Radiant-level Valorant coach talking directly with your player after (or during) a session. Be honest, specific, and encouraging, like a real coach in a VOD review. Casual tone, no fluff.

${statsLine}
${trendLine}
${matchesBlock}
${sessionsBlock}
Player's agent this session: ${ctx.agent || 'unknown'}.
${memLine}
${playbookLine}
${tipsBlock}
${ctx.noSessionYet ? 'IMPORTANT: this player has NOT played a coached session yet. You have no gameplay and no tips from them. Do not invent observations about their play. Answer general Valorant questions briefly and invite them to start coaching and play a match so you can review it together.' : ''}

Conversation so far:
${messages.map((m) => m.role + ': ' + m.content).join('\n')}

Reply as Coach to the player's last message. Rules:
- Only discuss Valorant and the player's gaming performance. If asked about anything unrelated, steer back to their gameplay in one friendly sentence.
- COACH LIKE THE BEST: first diagnose the ROOT CAUSE behind what they are asking (deaths usually trace to positioning, timing, or fighting without a trade partner before they trace to aim). Name the ONE highest-impact fix, then give a concrete drill or in-game habit to build it, for example 10 minutes of deathmatch focusing only on counter-strafe headshots, a minimap glance every 5 seconds, or reviewing one lost round per match and asking what info they had before the fight.
- Ground advice in proven Radiant and pro fundamentals: fight with a trade partner in view, clear angles in slices, use util before contact, take an off-angle once then move, keep economy discipline, reposition after kills.
- Combine their career stats with the match flow and this session's tips. The best answer ties a stat to a concrete example, and covers both aim and game sense, not just headshot rate.
- Be honest, do not praise a mistake as if it were good, and do not invent a mistake that is not there. Knife out while rotating through safe space is CORRECT (fastest movement), knife out where contact is possible is the mistake. Match abilities to their real purpose (Updraft and dashes are mobility, not tools to clear angles).
- Be concrete: name the exact habit or mistake and the fix, not generalities.
- 2 to 5 short sentences, under 120 words total. Plain text, no markdown, no lists.
- Use commas and periods, never dashes.
- If you genuinely lack the information to answer, say what you'd need to see.`;

    const ask = (p) => Promise.race([
      textInfer(p, 350),
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
module.exports.mapState    = mapState;             // exported for tests
module.exports.buildContextPrompt = buildContextPrompt;
