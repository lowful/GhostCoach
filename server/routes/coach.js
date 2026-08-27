'use strict';
const express  = require('express');
const supabase = require('../db/supabase');
const knowledge = require('../services/knowledge');
// The language list is shared with the client so both agree on what is
// supported, and so the prompt always names the language in English (a model
// follows "write in German" far more reliably than "write in Deutsch").
const { promptName: langPrompt } = require('../services/languages');
const locator   = require('../services/callout-locator');
const patchCtx  = require('../services/patch-context');
const telemetry = require('../services/telemetry');
const crypto    = require('crypto');
const router = express.Router();

// ─── Cost tracking (in-memory, resets on server restart) ──────────────────────
/**
 * Bounded cache write.
 *
 * Every cache in this file is keyed by Riot ID or match ID, so each one grows
 * with the number of distinct players seen and never shrinks. On a long lived
 * process that is a slow memory leak with exactly one ending: the container
 * exceeds its limit and the platform restarts it, which looks like a random
 * crash because nothing in the logs points at a cause.
 *
 * Map preserves insertion order, so the oldest keys are the front of the
 * iterator. Trimming to a cap costs nothing and turns an unbounded structure
 * into a bounded one, which is the whole point. Re-setting an existing key
 * deletes it first so a refreshed entry counts as recently used rather than
 * keeping its original position and being evicted while still hot.
 */
function cacheSet(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const overflow = map.size - max;
    let i = 0;
    for (const k of map.keys()) {
      if (i++ >= overflow) break;
      map.delete(k);
    }
  }
}

const costStore   = new Map();
const globalStats = { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '', month: '' };

/**
 * Indicative cost of one analyze call, in dollars.
 *
 * The default is priced from Qwen3-VL token rates (~2200 in, ~40 out), which is
 * NOT the model the code defaults to any more, so the figure drifts every time
 * the default model changes and the admin cost view quietly reports the wrong
 * dollars. AI_COST_PER_CALL overrides it so the number can be corrected in
 * Railway without a deploy, which is the only way this stays honest.
 */
const COST_PER_CALL = Number(process.env.AI_COST_PER_CALL)
  || ((2200 * 0.00000013) + (40 * 0.00000052));

function trackCall(key, units = 1) {           // units: frame-memory calls send 2 images
  const cost  = COST_PER_CALL * units;
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  if (globalStats.date !== today) {
    globalStats.callsToday = 0;
    globalStats.costToday  = 0;
    globalStats.date = today;
  }
  // Without this the monthly totals only ever reset when the process restarted,
  // so /api/admin/costs reported "since the last deploy" under a month label.
  if (globalStats.month !== month) {
    globalStats.callsMonth = 0;
    globalStats.costMonth  = 0;
    globalStats.month = month;
  }
  globalStats.callsToday++;
  globalStats.callsMonth++;
  globalStats.costToday  += cost;
  globalStats.costMonth  += cost;

  if (!costStore.has(key)) cacheSet(costStore, key, { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '', month: '' }, 5000);
  const e = costStore.get(key);
  if (e.date !== today) { e.callsToday = 0; e.costToday = 0; e.date = today; }
  if (e.month !== month) { e.callsMonth = 0; e.costMonth = 0; e.month = month; }
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
  // ONE vision model for every frame. We tried a hybrid (thinking model on buy
  // phase, instruct on live action) and it made map, side and spectating reads
  // WORSE, not better. The STATE machine locks the map and side only after two
  // agreeing reads, but the two models are different networks that read the HUD
  // differently, so a buy-phase read and an active read would disagree across
  // the phase boundary and the lock would never settle or would settle wrong.
  // The thinking model also spends its budget reasoning and can return a
  // truncated STATE. All-thinking was already too slow (it timed out on live
  // tips), so one fast model used consistently is the right call.
  //
  // NOTE: a value set in Railway (AI_VISION_MODEL) OVERRIDES this default, so
  // this line does not tell you what is live. Ask /health, which reports the
  // models actually in use. Whatever is chosen must be a VISION model and must
  // answer without reasoning first, see chatCall.
  visionModel: process.env.AI_VISION_MODEL || 'google/gemini-3-flash-preview',
  // Text tasks (grading, chat, reviews) also default to Gemini 3 Flash, which is
  // the stronger writer and answers directly rather than reasoning first.
  //
  // WHATEVER IS SET HERE OR IN RAILWAY, ASSUME IT MIGHT REASON. Reasoning is now
  // switched off per request in chatCall and textInfer retries any empty reply on
  // a different model, because the previous safety net keyed on the model NAME
  // containing "thinking" and therefore missed qwen3.7-flash entirely.
  textModel:   process.env.AI_TEXT_MODEL || 'google/gemini-3-flash-preview',
  // Unused by the live analyze loop; kept for anything that explicitly opts into
  // a deep-reasoning image read. Defaults to the same vision model so an unset
  // env var cannot silently reintroduce a second model.
  visionDeep:  process.env.AI_VISION_MODEL_DEEP || process.env.AI_VISION_MODEL || 'google/gemini-3-flash-preview',
};

// ─── Out-of-credits breaker ──────────────────────────────────────────────────
// EXHAUSTED CREDITS DO NOT ALWAYS ARRIVE AS 402.
//
// The breaker below originally keyed on the 402 status alone. A real outage
// proved that wrong: the account ran dry and OpenRouter answered 403 for every
// request instead. Nothing detected it, so the breaker never opened, the
// coaching loop hammered the provider every few seconds for the whole outage,
// and the player was told the coach was "temporarily down" rather than the
// truth, which was the one thing they could actually act on.
//
// So the status is now only half the test. Any refusal whose body talks about
// credits, quota or billing counts, whatever code it arrived under.
const CREDITS_TEXT = /credit|quota|insufficient|billing|payment required|out of funds|top ?up/i;

// ─── Agent knowledge ─────────────────────────────────────────────────────────
// KNOWLEDGE THE MODEL CANNOT READ OFF THE SCREEN, which is the only kind worth
// adding. Feeding it more of what it should be READING makes it worse: given a
// rich context it starts answering from the context instead of the frame, and
// it returned a 3-5 scoreline for a frame plainly showing 3-2. An agent's kit is
// the opposite kind of fact. It never changes, it is not on screen, and getting
// it wrong is invisible to the model.
//
// This replaces a hand-written roster that listed abilities as vague categories
// ("Iso: shield, wall") and openly gave up on newer agents, telling the model to
// guess for Vyse, Tejo and Waylay. Worse, the client's ability gate validates
// against the REAL names from this same data file, so the prompt was teaching a
// vocabulary the gate then rejected. One Iso session lost 7 tips that way.
//
// Generated from valorant-data.generated.json, so npm run sync:valorant keeps it
// correct as agents are added or reworked, with no prompt edit.
let AGENT_KIT = {};
try {
  AGENT_KIT = require('../valorant-data.generated.json').agents || {};
} catch (e) {
  console.log('[coach] agent kit data unavailable:', e.message);
}

// What each role is FOR, so the coaching fits the character being played rather
// than being generic advice with an agent name attached. The client already
// sends agentRole and the prompt never used it.
const ROLE_BRIEF = {
  Duelist:    'a Duelist, the one who takes space and opens sites. Coach entries, timing and trades, and hold them to using their kit to enter rather than to escape a fight they should not have taken.',
  Controller: 'a Controller, who decides what the enemy can see. Coach smoke timing and placement, cutting rotates, and using vision denial to make a site takeable rather than smoking on reflex.',
  Initiator:  'an Initiator, whose job is information and openings for others. Coach recon before contact, flashing for a teammate rather than themselves, and clearing an angle before the team commits.',
  Sentinel:   'a Sentinel, who holds ground and watches flanks. Coach anchoring, using kit to buy time alone, covering the rotate path, and not chasing kills away from the space they are meant to hold.',
};

/**
 * The player's actual kit, when their agent is confirmed.
 *
 * Deliberately narrow: only the agent being played. The old block listed all 24
 * agents it knew, which cost tokens on 23 irrelevant kits and invited the model
 * to reach for another agent's ability. When the agent is unknown the rule is
 * already "name no abilities", so a roster serves no purpose there either.
 */
function agentKitBlock(agent) {
  const name = String(agent || '').trim();
  const info = name && AGENT_KIT[name];
  if (!info) {
    return 'THE AGENT IS NOT CONFIRMED, so name NO ability at all, not even a generic one like "your flash". Coach positioning, crosshair placement, timing, economy or map control instead, all of which are true whoever they are playing.';
  }
  const abilities = (info.abilities || []).map((a) => String(a)).filter(Boolean);
  const role = ROLE_BRIEF[info.role] || `a ${info.role}`;
  return `THE PLAYER'S KIT. ${name} is ${role}
${name}'s abilities are exactly: ${abilities.join(', ')}. These are the ONLY ability names you may use. Any other ability name belongs to a different agent and instantly tells the player you are not really watching, so if the play you have in mind needs an ability ${name} does not have, coach something else.
Plain descriptions of their own kit are fine when they are accurate ("your smoke", "your flash", "your wall"), but the real name is better because it is what the player sees on their own keys.
BEFORE you name one, check the ability bar in THIS frame: bright means ready, dim or greyed means used or unbought, and on pistol rounds and ecos assume they are not bought unless you can see them lit.`;
}

// The model's own words for "I am looking at the spectator HUD". Matched against
// aliveTell only, which exists to describe the evidence for being alive, so
// these readings mean the opposite of what the health number says. Every pattern
// below is a phrasing taken from a real logged session.
const SPECTATE_TELL = /\bspectat(e|es|ing|or)\b|\bswitch player\b|\bkill ?cam\b|\bteammate\b[^.]{0,24}\bhp\b|\bwatching (a |your )?teammate\b/i;

// THE ONE SCREEN A LIVING PLAYER ALSO OPENS. Everything else the model reports
// spectating is a person or the spectator interface itself, which is exactly the
// evidence this tell is looking for: measured across 129 matching frames of real
// sessions it says a teammate's name, "teammate", "ui", "hud", "camera" or
// "screen". "Scoreboard" appeared once, on a frame where the screenshot shows
// the player alive at 100 HP with the scoreboard open and no SWITCH PLAYER
// anywhere, and the tell still read "own HP 100 and knife bottom center,
// spectating scoreboard". The rule then declared a live player dead in the
// middle of a round and threw away a correct health reading, which is the exact
// failure it was written to prevent, arriving from the other direction.
const SPECTATE_FALSE_FRIEND = /\bspectat(?:e|es|ing|or)\s+(?:the\s+)?(?:score\s?board|mini\s?map)\b/i;

// A RATE LIMIT IS NOT AN EMPTY WALLET, and it says so in words that overlap.
// Rate-limit bodies routinely mention "quota", which the wording test above
// treats as a money problem, so a burst of requests could trip the breaker, shut
// the coach down for five minutes, and tell the player to go top up an account
// that had money in it. That happened: a rapid benchmark sweep produced exactly
// this, and the balance was never the problem. Transience is the distinguishing
// feature, so it is checked FIRST and wins.
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|slow down|requests per|retry after|temporarily/i;

/** Is this provider refusal actually "the account has no money"? */
function looksLikeCreditsFailure(status, body) {
  if (status === 402) return true;                       // the documented case
  if (status !== 403 && status !== 429) return false;    // anything else is a real error
  const text = String(body || '');
  if (RATE_LIMIT_TEXT.test(text)) return false;          // throttled, not broke
  return CREDITS_TEXT.test(text);
}

// When the AI account runs dry every request 402s. The coaching loop fires
// every few seconds per player, so without a breaker the server spends the
// outage hammering the provider and filling the log with identical errors
// (exactly what a real outage looked like: hundreds of lines a minute).
// Once tripped we fail fast for a cooldown, then let ONE request through to see
// if credits are back.
const CREDITS_COOLDOWN_MS = 5 * 60 * 1000;
let creditsOutAt = 0;

function noteCreditsExhausted() { creditsOutAt = Date.now(); }
function creditsLookExhausted() {
  return creditsOutAt > 0 && Date.now() - creditsOutAt < CREDITS_COOLDOWN_MS;
}
function clearCreditsFlag() {
  if (creditsOutAt) console.log('[coach] AI credits are working again');
  creditsOutAt = 0;
}
/** How long until the breaker lets a probe through, in seconds. */
function creditsRetryIn() {
  return Math.max(0, Math.ceil((CREDITS_COOLDOWN_MS - (Date.now() - creditsOutAt)) / 1000));
}

// One OpenAI-style chat call. `imageB64` present => multimodal (vision) request.
// Accepts a single base64 string or an ordered array (frame memory sends
// [previousFrame, currentFrame]; the prompt explains the order).
async function chatCall({ prompt, imageB64, maxTokens, temperature, model: pinnedModel }) {
  // Fail fast while the credits breaker is open: the provider would only 402
  // again, and every attempt costs a round trip and another identical log line.
  if (creditsLookExhausted()) {
    const err = new Error('AI credits exhausted');
    err.status = 402;
    err.credits = true;
    throw err;
  }
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
  //
  // "Is this a thinking model" USED TO BE ANSWERED BY THE NAME ALONE, and that
  // was wrong in the one way that matters: silently. Pointing the coach at
  // qwen/qwen3.7-flash, a reasoning model with no "thinking" in its name, made
  // every single call return an empty string. Not an error, not a degraded tip,
  // nothing: the model reasoned through the whole answer budget and the overlay
  // simply stopped speaking. Measured at 0 tips and 0 STATE lines across 10 real
  // frames, which also kills the feedback loop, because a STATE that never
  // arrives is indistinguishable from a quiet round.
  //
  // So reasoning is now switched OFF explicitly rather than assumed absent. A
  // live tip is latency bound and has nothing to reason about beyond what is on
  // screen, so this is what we want anyway. Models that cannot disable it are
  // caught below by the response itself.
  const isThinking = /thinking/i.test(model);
  // Reasoning happens BEFORE the answer and comes out of the same budget, so a
  // thinking model that reasons past the cap returns a truncated <think> block
  // and nothing else, which reads as an empty reply. Text work (grading, chat,
  // reviews) is not latency bound, so it gets real room; vision stays tighter
  // because a live tip has to land inside the frame timeout.
  const headroom = isThinking ? (images.length ? 700 : 2200) : 0;
  const budget = (maxTokens || 100) + headroom;

  const send = (maxT, thinkOn) => fetch(`${AI.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${AI.apiKey}`,
      'HTTP-Referer':  'https://occlara.app', // OpenRouter attribution (ignored elsewhere)
      'X-Title':       'GhostCoach',
    },
    body: JSON.stringify({
      model,
      messages:    [{ role: 'user', content }],
      max_tokens:  maxT,
      temperature: temperature == null ? 0.7 : temperature,
      // OpenRouter's unified switch. Hybrid reasoners answer directly instead of
      // thinking first; providers that do not support it ignore the field.
      reasoning:   thinkOn ? undefined : { enabled: false },
    }),
  });

  let resp = await send(budget, isThinking);

  if (!resp.ok) {
    const text = await resp.text();
    // 402 means the AI account is out of credits. That is NOT a transient
    // outage: retrying cannot fix it, so it must be reported differently from a
    // hiccup (the player was told "temporarily down" and reasonably assumed a
    // bug) and it must open the breaker so we stop hammering the provider.
    const outOfCredits = looksLikeCreditsFailure(resp.status, text);
    if (outOfCredits) {
      noteCreditsExhausted();
      console.error(`[coach] AI OUT OF CREDITS (${resp.status}). Top up at https://openrouter.ai/settings/credits`);
    } else {
      console.error(`[coach] AI error (${resp.status}):`, text.slice(0, 200));
    }
    const err = new Error(`AI ${resp.status}`);
    err.status = resp.status;
    // Carried separately from the status, because the status alone cannot
    // answer this question. Everything downstream keys off the flag.
    err.credits = outOfCredits;
    throw err;
  }
  clearCreditsFlag();   // a successful call proves credits are available again
  let data = await resp.json();
  let raw = answerOf(data);

  // ALWAYS-ON REASONERS: the switch above is a request, not a guarantee. Some
  // models reason regardless, and when they do it comes out of the same budget,
  // so the answer is empty for a reason the caller cannot see. Ask the RESPONSE
  // rather than the model name: an empty answer plus evidence of reasoning is
  // the signature, and it is worth exactly one retry with real headroom. An
  // empty answer with no reasoning is a genuine "nothing to say" and is left
  // alone, because on the vision path that is a legitimate SKIP.
  if (!raw && burnedBudgetThinking(data)) {
    console.warn(`[coach] ${model} reasoned past its answer budget, retrying with headroom`);
    const retry = await send(budget + (images.length ? 700 : 2200), true);
    if (retry.ok) {
      data = await retry.json();
      raw = answerOf(data);
    }
  }
  return stripThinking(raw);
}

/** The assistant's actual answer, independent of provider quirks. */
function answerOf(data) {
  const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  return msg.content || '';
}

/**
 * Did this response spend its whole budget reasoning instead of answering?
 *
 * OpenRouter reports reasoning separately from content, so the tell is direct:
 * reasoning came back, the answer did not, and generation stopped because it hit
 * the cap. Keyed on the reply rather than the model id so a newly configured
 * model cannot silently reintroduce the empty-tip outage.
 */
function burnedBudgetThinking(data) {
  const choice = (data && data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  const usage = (data && data.usage) || {};
  const details = usage.completion_tokens_details || {};
  const reasoned = !!(msg.reasoning || msg.reasoning_content || details.reasoning_tokens > 0);
  return reasoned || choice.finish_reason === 'length';
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

/**
 * Model bake-off support: run ONE analyze call on a different vision model.
 *
 * Which model to run is the most consequential choice in this product and the
 * only honest way to answer it is to put candidates in front of real frames and
 * compare their HUD reads against a known-correct one. A spec sheet cannot tell
 * you whether a model can read a two-digit health number at 854x480.
 *
 * This overrides the model for a single request, deliberately inside the real
 * analyze route so the bake-off exercises the production prompt, budget, timeout
 * and STATE parsing rather than an approximation of them.
 *
 * Safety: the allowlist is fixed and every entry costs no more per hour than the
 * configured model, so a leaked license key cannot use this to run up a bill on
 * an expensive model. Unknown values are ignored rather than rejected, so this
 * can never break a normal client call.
 */
const BENCH_MODELS = new Set([
  'google/gemini-3-flash-preview',        // the previous default, the read to beat
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash-lite',
  'google/gemini-2.5-flash',
  'openai/gpt-5-mini',
  'openai/gpt-4.1-mini',
  'qwen/qwen3.7-flash',                   // current
  'qwen/qwen3-vl-235b-a22b-instruct',     // what this app originally shipped on
  'qwen/qwen3-vl-30b-a3b-instruct',
  'z-ai/glm-4.6v',
  'mistralai/mistral-small-3.1-24b-instruct',
]);
function benchModel(req) {
  const m = String((req.body && req.body.benchModel) || '').trim();
  return BENCH_MODELS.has(m) ? m : null;
}

// Unified entry points the routes call: dispatch to the configured provider.
async function visionInfer(imageB64, prompt, maxTokens, jsonMode, model) {
  if (AI.provider === 'gemini') return geminiCall(imageB64, prompt, maxTokens, jsonMode);
  const text = await chatCall({ imageB64, prompt, maxTokens, temperature: 0.7, model });
  return jsonMode ? text : sanitize(text);
}
/**
 * Text work with a self-healing model choice.
 *
 * A thinking model can spend its whole budget reasoning and return nothing
 * usable. That silently broke session grading (which fell back to canned filler)
 * and Ask Coach (which showed "Chat failed"), because an empty string is not an
 * error, it just parses into nothing. So: an empty reply is retried once on the
 * instruct model, and after a couple of strikes this process stops paying the
 * thinking cost for text at all. Self-healing, so it does not depend on anyone
 * changing an environment variable to recover.
 *
 * jsonMode skips the tip sanitiser, which is meant for prose, not JSON.
 */
let thinkingTextStrikes = 0;
const THINKING_TEXT_LIMIT = 1;   // one failure is enough, do not keep paying for it

// The fallback has to be a DIFFERENT model, which used to be assumed rather than
// checked. It derived from the vision model, and once vision and text were both
// pointed at the same model the "fallback" retried the exact call that had just
// returned nothing. A known instruct model is the backstop, because the point of
// this path is to answer the player, not to be frugal about a call that is only
// made when a feature would otherwise be broken.
const TEXT_BACKSTOP = 'google/gemini-3-flash-preview';
function instructFallbackModel(failed) {
  const pick = process.env.AI_TEXT_MODEL_FALLBACK
    || (/thinking/i.test(AI.visionModel) ? 'qwen/qwen3-vl-235b-a22b-instruct' : AI.visionModel);
  return pick && pick !== failed ? pick : TEXT_BACKSTOP;
}
function textModelNow() {
  const configured = AI.textModel;
  if (thinkingTextStrikes >= THINKING_TEXT_LIMIT) return instructFallbackModel(configured);
  return configured;
}

async function textInfer(prompt, maxTokens, opts) {
  if (AI.provider === 'gemini') return geminiTextCall(prompt, maxTokens);
  const { json = false, timeoutMs = 0 } = opts || {};
  const finish = (t) => (json ? String(t || '') : sanitize(t));
  const run = (model) => {
    const call = chatCall({ prompt, maxTokens, temperature: 0.5, model });
    if (!timeoutMs) return call;
    return Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error('text timeout')), timeoutMs)),
    ]);
  };

  const model = textModelNow();
  const fallback = instructFallbackModel(model);
  // THE SYMPTOM IS THE EMPTY REPLY, NOT THE MODEL'S NAME.
  //
  // This recovery used to run only when the model id matched /thinking/, which
  // meant it sat dormant through the exact outage it was written to prevent:
  // qwen3.7-flash reasons but is not called "thinking", so Ask Coach served its
  // canned "ask me about a round" line and grading served filler, both looking
  // like working features. Any empty reply now earns the retry.
  let out = '';
  let failure = null;
  try {
    out = await run(model);
  } catch (e) {
    if (model === fallback) throw e;   // nothing left to try, that is a real error
    failure = e.message;
  }
  if (out && out.trim()) return finish(out);
  if (model === fallback) return finish(out);

  // Nothing came back, or it timed out. Either way this model is not answering
  // text right now, so record the strike and let later calls skip straight past
  // it rather than paying for the same silence every time.
  thinkingTextStrikes++;
  console.warn(`[coach] ${model} unusable for text (${failure || 'empty reply'}), `
    + `strike ${thinkingTextStrikes}/${THINKING_TEXT_LIMIT}, retrying on ${fallback}`);
  return finish(await run(fallback));
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
  // Death reviews were inventing specifics: who killed the player, with what,
  // and how many kills they had first. None of that is knowable unless the kill
  // feed says so, and a wrong detail discredits an otherwise correct lesson.
  const deathFacts = `
NEVER INVENT THE DETAILS OF A DEATH. Do not name who killed the player, what weapon killed them, or how many kills they got first, unless the KILL FEED actually says so. If the feed does not tell you, describe only what you can see: the position they were in and the habit that put them there ("you died holding that angle alone with no trade") rather than a story ("you died to Yoru in A Garden after two kills"). A death review with one invented detail teaches the player to distrust the whole review.
`;
  // While the player is dead the camera is on a TEAMMATE, so everything on the
  // HUD describes that teammate. Reported as its own rule because the model
  // cannot tell from the pixels alone whose loadout it is looking at, and it
  // was confidently attributing the spectated player's gun to the player.
  const spectatorLine = (ctx.playerAlive === false || ctx.phase === 'dead')
    ? `THE PLAYER IS DEAD AND YOU ARE LOOKING AT A TEAMMATE'S CAMERA. Every live HUD element on this frame belongs to THAT TEAMMATE, not to your player: the health, the weapon, the abilities, the credits, the position and the crosshair are all theirs. Do NOT say the player is holding, using, or standing anywhere based on this frame, and never describe their weapon from it. If you review the death, describe what the player did BEFORE they died, using the earlier frames and the match memory, and report weapon as null rather than guessing.

THE LOCATION LABEL ON THIS FRAME IS THE TEAMMATE'S LOCATION, NOT WHERE THE PLAYER DIED. It moves with the spectator camera, so it is different on almost every frame while the player lies dead in one place.\n\n`
    : '';

  // WHERE THE DEATH HAPPENED, stated wherever a review might be written.
  // This used to live only inside the spectating block, but reviews also land a
  // frame or two AFTER the player respawns, and on those frames the block was
  // gone and the model went back to naming whatever location the last frame
  // showed. One session claimed deaths at A Sewer, B Site and Mid Window while
  // the frame label read Mid Doors, A Site and Defender Side Spawn.
  const deathWhereLine = (ctx.deathSpot || ctx.justDied || ctx.playerAlive === false || ctx.phase === 'dead')
    ? (ctx.deathSpot
        ? `WHERE THE PLAYER DIED: ${String(ctx.deathSpot).slice(0, 40)}. This was captured at the moment of death and it is the ONLY location you may name when talking about that death. Do not name any other place, and do not use the location shown on the current frame, which is wherever the camera is now.\n\n`
        : `THE DEATH LOCATION WAS NOT CAPTURED. Name NO location at all for this death, describe the mistake without a place. Guessing a callout here teaches the player to distrust every review you write.\n\n`)
    : '';

  // THE COACH KEPT REVIEWING DEATHS THAT HAD NOT HAPPENED.
  //
  // In one session ten tips narrated a death while the player was alive, and
  // several reached the overlay, including "You died holding that tight angle
  // alone" at 100 HP and "You are spectating Iso" to someone playing the round.
  // The prompt only ever spoke about deaths when one had just occurred, so
  // nothing told the model NOT to invent one, and a killcam-looking frame or a
  // dead teammate on screen was enough.
  //
  // The client now rejects these outright, but a rejected tip is silence, and
  // silence is a cost too, so it is worth not generating them in the first
  // place. Stated positively and with the number attached, because "the player
  // is alive" is weaker than "the player is alive at 87 HP".
  const aliveNow = ctx.playerAlive === true
    || (typeof ctx.playerHp === 'number' && ctx.playerHp > 0);
  const aliveLine = (aliveNow && !ctx.justDied)
    ? `THE PLAYER IS ALIVE RIGHT NOW${typeof ctx.playerHp === 'number' ? `, at ${ctx.playerHp} HP` : ''}, and is playing this round. Do NOT review a death, do NOT tell them they died, and do NOT tell them they are spectating or watching a killcam. If a dead teammate, a kill feed entry or a death recap is on screen, that is somebody else. Coach the round they are actually in. A living player told they are dead stops believing everything else you say.\n\n`
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

  // The real minimap layout for the map actually being played (sites, whether a
  // mid exists, and the only callouts that legitimately exist there). Empty
  // until the map is locked, which is deliberate: with no verified map we would
  // rather give general directions than a confident callout from the wrong map.
  const mapBlock = locator.minimapBrief(ctx.map);

  // WHAT THIS PLAYER KEEPS DOING WRONG, counted across the week rather than
  // guessed from one frame. The app already worked this out for the weekly
  // report and never told the coach, so every session began with no memory of
  // the person being coached and the same lesson had to be rediscovered from
  // scratch. Phrased as something to WATCH FOR rather than to repeat, because
  // the failure mode here is obvious: hand a coach a list of faults and it will
  // read them back every round.
  const habitBlock = (Array.isArray(ctx.habits) && ctx.habits.length)
    ? 'WHAT THIS PLAYER KEEPS DOING WRONG (counted across their last week of coached games, so this is who they are, not a guess from this frame):\n'
      + ctx.habits.slice(0, 3).map((h) => `- ${String(h.label || '').slice(0, 60)}`
          + (h.sessions ? ` (seen in ${h.sessions} sessions)` : '')
          + (h.fix ? `. The fix: ${String(h.fix).slice(0, 150)}` : '')).join('\n')
      + '\nWatch for these specifically, and when you SEE one happening say so in the moment, that is when it lands. Do NOT recite them as a list, do not open with them, and never coach a habit the frame does not actually show: a coach who repeats last week\'s notes over a live round is not watching. If they are clearly avoiding one of these, say that instead, people repeat what gets noticed.\n\n'
    : '';

  // What the live patch changed for THIS player's agent and gun, in Riot's own
  // words, so the coach never teaches a habit that was just nerfed.
  const patchBlock = patchCtx.patchBrief(ctx.agent, ctx.playerWeapon);

  // Everything the coach sees is a few seconds old by the time the player hears
  // it, so location wording has to survive the player having moved on.
  const delayBlock = `

THE PLAYER HAS ALREADY MOVED. This frame reached you seconds ago, so by the time they hear you they are somewhere slightly different. Never phrase a tip as if you are watching them live in that exact spot.
- Say the AREA, not the pixel: "around A Main", "near Hookah", "on your way to B", not "you are standing at the top of A Main right now".
- Never give a tip that only works if they are still in the exact spot you saw ("turn left now", "shoot the guy in front of you"). Coach the next few seconds instead: what to set up, where to go, what to expect, what to stop doing.
- Ongoing habits and positioning always beat frame-perfect reactions, because habits are still true ten seconds later.
- If the only honest tip would need the player frozen where you saw them, SKIP.`;

  // The single worst failure: naming a SITE or callout the player is not
  // actually at. It reads as authoritative and it is simply wrong, so the
  // player learns to distrust every tip. A tip once told a player holding A to
  // go hold C, purely because C was a plausible thing to say on that map.
  const knownSpot = ctx.playerSpot && ctx.playerSpotVerified;
  const locationGuard = `

DO NOT GUESS WHERE THE PLAYER IS. A callout existing on this map does not mean the player is near it. Only tie a tip to a specific site or callout when you ACTUALLY KNOW the player is there. You know that from ONE of: their yellow arrow's position on the minimap this frame, the verified location given below, or a landmark you can plainly see in the first-person view (a named area, the spike planted on a site). ${knownSpot ? 'The verified location below was resolved from the minimap coordinates, so you may build the tip around it.' : 'No verified minimap location came through this frame, so unless you can directly SEE which site the player is on, you do not know it, and must not name one.'}
- If you do not know the player's site, coach something that is true anywhere: crosshair placement, trading, using util before peeking, checking the minimap, resetting after a kill, economy. These never depend on a location.
- NEVER pick a site or callout just to make a tip sound specific. "Hold C Waterfall for time" when you cannot see that the player is on C is the exact mistake that breaks trust. A general but correct tip beats a specific but guessed one every time.
- Wrong side plus wrong site equals pure anti-coaching. When in doubt about position, stay location-agnostic or SKIP.

BEFORE YOU NAME ANY CALLOUT, CHECK THE MAP TWICE. Ask yourself: which map am I actually looking at, and does this callout exist on THAT map? Naming a callout from a different map is the most obvious possible error to a player, it instantly tells them the coach is not really watching. A player on Breeze being told to hold "Elbow" or rotate to "B Back Site", which are Ascent callouts, is exactly this failure. If the callout you are about to use is not in this map's list above, do not use it, and if the map itself does not match the minimap in front of you, report the corrected map in STATE and keep the tip location-free this frame.`;

  // The same failure, for abilities: telling the player to use a dash, flash or
  // smoke they have already spent. Cooldowns are hard to read off a small frame
  // and your frame is seconds old, so an ability you saw available may be gone.
  const abilityGuard = `

DO NOT TELL THE PLAYER TO USE AN ABILITY YOU CANNOT CONFIRM THEY HAVE. Abilities go on cooldown, get used, or were never bought, and greyed-out icons are hard to read on this frame, which is already seconds old. A dash or flash you think is available may already be spent, so a tip like "use your dash to reposition" is often just wrong.
- Coach the ACTION or GOAL, not the ability: "reposition after the kill, do not rehold the same angle" is right whether or not the dash is up. "Use your dash to reposition" gambles on an ability you cannot verify.
- Only name a specific ability to USE when it is clearly central to the tip AND you can see it is actually available (its icon is lit, not greyed). If you are not sure, coach the goal and let the player pick the tool.
- This applies to every agent's kit: dashes, flashes, smokes, mollies, walls, recon, ults. When unsure, describe what to achieve, not which button to press.

COACH WHAT YOU SEE, NEVER WHAT YOU ASSUME. This is the difference between a coach and a guesser. Everything you say has to trace back to something actually on this screen: the HP number, the kill feed, the minimap icons, the spike, the round timer, the score. Do not narrate a story about what probably happened.
- Do not assume a fight happened, a teammate died, an enemy is somewhere, or the player took damage. Check the kill feed and the minimap, they tell you the truth for free.
- Do not assume the player died. If their health number is on screen they are alive, no matter what else the frame looks like.
- Do not assume where enemies are from "what usually happens on this map at this time". Only a red icon, a question mark ping, or an enemy you can actually see counts.
- If you find yourself using words like "probably", "likely", "they must have", or "it looks like they", stop: that is a guess, and a guessed observation makes the whole tip untrustworthy even when the advice is sound.
- When the frame does not tell you enough for a specific tip, give a correct general one or SKIP. Being quiet costs nothing. Being confidently wrong costs the player's trust in every future tip.`;

  // The spike decides rounds, so once it is down it outranks almost every other
  // read. This was missing entirely: the coach would talk about angles and
  // positioning while the round was being lost on the timer.
  const spikeState = String(ctx.spike || '').toLowerCase();
  const defending  = String(ctx.side || '').toLowerCase().includes('def');
  const spikeBlock = spikeState === 'planted' ? `

THE SPIKE IS DOWN${ctx.spikeSpot ? ' at ' + ctx.spikeSpot : ''}. THIS IS NOW THE ROUND. The spike is the win condition, it does not care about kills, and the clock is running.
${defending
  ? 'The player is DEFENDING, so they must RETAKE. Nothing else wins this round: no amount of holding an angle somewhere else matters once the spike is planted. Get them moving toward the spike with a plan, not just "go there": how to enter (util first, not a dry run in), where to clear, whether to wait a beat for a teammate so the entry gets traded, and that they need TIME to defuse, so late is the same as never. If they are far from the site, the tip is to rotate to it now. A defuse needs 7 seconds, or 3.5 with a half defuse, so remind them to start it with enough clock and to use cover or a smoke for it if they can.'
  : 'The player is ATTACKING and the spike is planted, so the job is to KEEP it, not to hunt kills. Coach the post plant: hold angles that watch the spike, play for time rather than for picks, use util to deny the defuse, and do not push out into a retake and give the site back. Dying away from the spike is how a won round gets lost.'}` : '';

  // Read the scoreline and match the coaching to it. A player cruising 4-0 does
  // not need urgent corrections every round; a stream of drastic calls there
  // reads as noise and makes the coach easy to tune out.
  const teamSc = typeof ctx.teamScore === 'number' ? ctx.teamScore : null;
  const enemySc = typeof ctx.enemyScore === 'number' ? ctx.enemyScore : null;
  const lead = teamSc != null && enemySc != null ? teamSc - enemySc : null;
  const scoreMood = lead == null ? '' : lead >= 4 ? `

THE PLAYER IS COMFORTABLY AHEAD (${teamSc}-${enemySc}). What they are doing is working, so do not coach as if the match is slipping away. Raise your bar for speaking at all: only interrupt for something that genuinely costs them this round, and let the quiet rounds be quiet. No sweeping strategy changes, no telling them to overhaul a setup that is winning. A short reinforcement of what is working, or silence, beats another correction.` : lead <= -4 ? `

THE PLAYER IS WELL BEHIND (${teamSc}-${enemySc}). Keep it steady and practical. They do not need to be told they are losing, they can see the score. Coach the next round only, one concrete fixable thing at a time, and keep the tone level: piling on when someone is already down makes them play worse, not better.` : '';

  const s = ctx.playerStats;
  const extLine = s && (s.kpr != null || s.adr || s.acs)
    ? `Per round over their last ${s.matches || 'few'} matches: ${s.kpr != null ? s.kpr + ' kills, ' : ''}${s.dpr != null ? s.dpr + ' deaths, ' : ''}${s.apr != null ? s.apr + ' assists, ' : ''}${s.adr ? s.adr + ' damage (ADR), ' : ''}${s.acs ? s.acs + ' combat score (ACS)' : ''}.
Per-round reads: KPR 0.8+ is strong fragging, under 0.6 is low impact, coach them into more fights WITH a trade partner. DPR 0.85+ means overexposure, coach positioning and patience. ADR under 120 means low damage output, coach taking more efficient fights and finishing chip damage. High assists with low kills means they support well but never convert, coach follow-up aggression.
`
    : '';
  /**
   * How this player performs ON THE AGENT THEY ARE PLAYING RIGHT NOW.
   *
   * The tracker already returns a per-agent breakdown and the prompt used only
   * the top agent's NAME, throwing away the numbers. That is the difference
   * between "your K/D is 1.05" and "your K/D is 1.27 on Iso and 0.69 on Jett,
   * and you are on Jett", which is the kind of thing a coach who actually knows
   * you would open with.
   *
   * Career shape, not frame state, so it is safe to send: it cannot pull the
   * model away from reading the screenshot the way volatile numbers do.
   */
  const agentForm = (() => {
    const list = (s && Array.isArray(s.topAgents)) ? s.topAgents : [];
    if (!ctx.agent || !list.length) return '';
    const norm = (n) => String(n || '').trim().toLowerCase();
    const mine = list.find((a) => norm(a.name) === norm(ctx.agent));
    const best = list.slice().sort((a, b) => (b.kd || 0) - (a.kd || 0))[0];
    if (!mine || (mine.matches || 0) < 2) {
      // Too few games to say anything honest about, and saying it anyway would
      // be inventing a trend from one match.
      return best && norm(best.name) !== norm(ctx.agent)
        ? `THIS AGENT IS NOT ONE OF THEIR REGULARS. They have barely played ${ctx.agent} recently, so expect rusty mechanics and unfamiliar util timings, and coach the basics of the kit rather than fine detail. Their most productive agent lately is ${best.name} (K/D ${best.kd}).\n\n`
        : '';
    }
    const bits = [`K/D ${mine.kd}`];
    if (mine.acs) bits.push(`ACS ${mine.acs}`);
    if (mine.winRate != null) bits.push(`${mine.winRate}% win rate`);
    let line = `ON THIS AGENT SPECIFICALLY: over their last ${mine.matches} games as ${mine.name} they average ${bits.join(', ')}.`;
    if (best && norm(best.name) !== norm(mine.name) && (best.kd || 0) > (mine.kd || 0) + 0.25) {
      line += ` They are noticeably better on ${best.name} (K/D ${best.kd}), so this is not their strongest pick and the gap is usually habits rather than aim: unfamiliar util, worse spacing, hesitant entries.`;
    } else if ((mine.kd || 0) >= 1.2) {
      line += ` This is one of their strongest picks, so coach for impact and round-winning plays rather than survival.`;
    }
    return line + ' Use this to pitch the tip, never to excuse a mistake, and never quote the numbers back at them.\n\n';
  })();

  const profileBlock = s && !s.error
    ? `PLAYER PROFILE (tracker stats over recent competitive matches): rank ${s.rank || 'unknown'}${s.peakRank ? ' (peak ' + s.peakRank + ')' : ''}, K/D ${s.kd || '?'}, headshot ${s.headshotPct || '?'}%, win rate ${s.winRate || '?'}%, top agent ${s.topAgent || 'unknown'}.
${extLine}${agentForm}Use these stats to decide WHAT to prioritise, then combine that with what the screenshot actually shows this frame. The strongest tip is a career weakness that also shows up on screen right now. Never give a stat-based tip the frame does not support.
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

  // THE TIP IS WRITTEN IN THE PLAYER'S LANGUAGE, the STATE line never is.
  //
  // STATE is parsed by mapState() against fixed English keys and values, so a
  // translated one would break the feedback loop silently: tips keep appearing
  // and simply stop being informed by anything. Callouts stay in the game's own
  // language too, because that is what is printed on the player's screen and
  // what their team says out loud.
  // SAYING IT ONCE AT THE TOP IS NOT ENOUGH.
  //
  // The instruction opened the prompt and then ~160 lines of English rules and
  // English example tips followed, so a weaker instruction-follower drifts back
  // to English by the time it writes line 1. Measured on the model that exposed
  // this: 1 of 6 non-English requests complied, and the one that did mixed
  // English words back in. So it is repeated in the OUTPUT block, where the
  // model is actually deciding how to write the sentence.
  const langReminder = (ctx.language && ctx.language !== 'en')
    ? `LANGUAGE, THIS OVERRIDES THE WORDING OF EVERY EXAMPLE ABOVE: line 1 must be written in ${langPrompt(ctx.language)}, not English. Every example tip in this prompt is written in English only to show the SHAPE of a good tip, never the language to answer in. Map callouts stay exactly as the game prints them, and line 2 stays entirely English. Write line 1 in ${langPrompt(ctx.language)} now.`
    : '';
  const langLine = (ctx.language && ctx.language !== 'en')
    ? `WRITE THE TIP IN ${langPrompt(ctx.language).toUpperCase()}. Line 1 must be natural, fluent ${langPrompt(ctx.language)} as a real teammate would speak it, not a stiff translation of an English sentence. TWO THINGS STAY EXACTLY AS THEY ARE: the map callouts (A Main, Hookah, Mid Top and so on), because that is what is written on the player's screen and what their team says out loud, and the entire STATE line on line 2, whose keys and values are machine read and must remain English. Never translate SKIP or LOBBY either.\n\n`
    : '';

  return `${langLine}You are a Radiant and professional level Valorant coach watching a live match through the player's screen. Give ONE short, specific, high-value tip, or the single word SKIP. Nothing else.

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
- WHEN THE MINIMAP SHOWS A PUSH, THAT IS THE TIP. Nothing else matters more than where the enemy team actually is. If push is set and it is a DIFFERENT site from where the player is, do NOT coach the angle they are standing on: telling someone to hold A Link while three enemies are confirmed into B is the single worst tip this coach can give, because it keeps them out of the round entirely. Lead with the read in the player's own language, the count and the site, then the decision. "Three confirmed B, rotate now through mid" or "Two showing A, hold your angle, this is a two man look not a commit". Say the number and the site out loud, that alone is worth more than most advice.
  Decide rotate against hold from what you can actually see:
  - push is LIVE and pushOnSite is true, at a different site: they are committed, rotate NOW and say the safe route. Late is the same as never.
  - push is LIVE and pushOnSite is false, at a different site: they are looking, not committed. Say the read and tell the player to be ready to rotate, but not to abandon their site yet, this is exactly what a fake is built to steal.
  - push is STALE (question marks): that is where they WERE. Treat it as a lean, not a fact. Coach a reposition or a check, never a full rotate off a question mark alone.
  - push is at the player's OWN site: do not rotate them anywhere, coach the fight. Numbers first ("three coming B, you are one, fall back and wait for your rotate rather than dying first"), then the angle.
  - A push of 4 or 5 at one site means the rest of the map is empty: a lone defender elsewhere should stop holding a dead angle and rotate or play for the retake.
  Never invent a push. When push is null, coach normally and do not guess at their plan.
- Mid (1:00 to 0:30): react to CONFIRMED pressure, delay with util, trade, rotate only on real info (spike down or a numbers read).
- Late (under 0:30, no plant): the time pressure is on THEM now, expect a desperate fast hit or forced execute, hold tight and let them make the mistake, the clock is your ally.
- Post-plant (45s): retake as a GROUP with the defuse clock in mind, do not trickle in one by one, clear with util before you swing.
If the timer is unreadable, coach from the phase and what you can see instead. Never give a tip that fights the clock (no slow default with 20 seconds left, no dry retake with the spike about to pop).

COACH THIS ONE PLAYER, NOT THE TEAM
You are watching ONE player. Every tip is about what THEY should do right now, the decision THEY control, not a command for the whole team. Never say "push as five", "everyone rotate", "team stack B", or any order the player cannot carry out alone, it is useless to them. "Push as 5" is rarely even the right play, so give the player their OWN move: if the team commits, coach the player's part in it ("go in behind your entry and trade him"); if the player is better off alone, say so ("let them take that fight, you swing wide for the pick"). Trading, timing your swing with a teammate, holding a crossfire, those are the PLAYER's actions and are fine. A team-wide order is not.

DIAGNOSE THE NEED, THEN PRESCRIBE (never give a fix for a problem the player is not showing)
Find the mistake on the screen FIRST, then give its fix. Do not fire a tip just because it is good advice, only when THIS frame shows the symptom. Common mistakes and their fixes, use the fix ONLY when you can actually SEE the symptom:
- Crosshair on the floor or wall between fights, aimed low: raise it to head level and pre-aim the corner you are about to clear.
- Wide-swinging a whole angle at once into the unknown: jiggle or shoulder-peek to bait and clear it in slices, do not expose your whole body.
- Dry-peeking a held angle with no util: flash, smoke, or bait it first, a dry peek into a set crosshair is a free death.
- Repeeking the same spot right after a kill: reposition, they are pre-aiming that pixel now.
- Standing still, over-holding one angle for many seconds: move, an angle held too long gets pre-fired or flanked.
- Pushing or peeking out of trade range of teammates: stay a step from a teammate so your death is traded, or do not take the fight.
- Wasting util early with no plan (a lone dart, a random smoke): hold util for the execute or the retake where it buys space or time.
- Caught reloading or swapping in the open: reload behind cover, not in a sightline.
- Chasing a kill or over-committing after winning a duel: take the trade you earned, then reset, greed loses the round.
- Bad crossfire, you and a teammate staring the same angle: one of you take a different angle so an entry meets two guns.
- No cover discipline, standing in the open mid-fight: use the wall or box, make yourself a hard target.
- Predictable, same play every round (same spot, same peek): mix it up, they have read you.
Mechanics and mental are fair game too when you see them: low or lazy crosshair, spraying at range instead of tapping or bursting, panic-rotating off one sound, tilting after a death. If none of these is visibly happening, do not invent one, coach the clearest real thing or SKIP.

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
IDENTIFY THE MAP FROM THE MINIMAP, not a vibe: count the bomb sites. HAVEN and LOTUS are the only maps with THREE sites (A, B, and C), so three site letters means Haven or Lotus, never Bind or a two-site map. Tell those two apart by shape: Lotus is round with rotating doors, Haven is not. Every other current map has exactly two sites (A and B). Bind is a two-site map with NO middle, its sites connect by teleporters. If you are not certain which map it is, report null for map and give general directions, a wrong map lock poisons every callout for the rest of the match.
NOT EVERY MAP HAS A MID: before you ever say "mid", "take mid control", or "lurk mid", confirm the CURRENT map actually has a middle by cross-referencing which map it is. BIND has NO mid at all, its two sites connect only by teleporters, so any mid tip on Bind is always wrong. Fracture is split from both attacker sides, not one mid lane. Ascent, Split, Icebox, Haven, Breeze, Pearl, Sunset, Lotus, Abyss all have a real contested mid. On a no-mid map coach the actual lanes and sites instead, and if you are not sure the map has a mid, do not mention mid.
CALLOUT PRECISION: a specific callout (B Main, Hookah, Market) may ONLY be used when the frame or minimap clearly shows the player at that exact spot. When you know the area but not the precise spot, say it at site level instead: "on B", "near A site", "in mid" (only on a map that has one). Saying B Main when the player died on B site is wrong in a way the player instantly notices, and a right-but-general location always beats a specific-but-wrong one. This applies doubly to death reviews: "You died on B holding too wide an angle" is a great review even without the exact pixel.

COACH THE TEAM'S PLAN
Before the round starts, the minimap tells you the plan: where the four BLUE teammate icons set up or head relative to the player's YELLOW icon. Coach the player's ROLE inside it:
- Player alone while the team groups elsewhere: they are LURKING. Coach lurk craft: stay unseen, strike when the team makes noise, watch the rotation path, do not die before the hit starts.
- Team split into two groups: a SPLIT. Both prongs must swing together, coach the player's prong timing so they are not early or late.
- Five spread across the map early: a DEFAULT. Coach info gathering and staying tradeable until the call comes.
- Five together: a STACK or EXECUTE. Coach spacing, trade order, and util sequencing through one choke.
${ctx.teamRead ? 'TEAM PLAN AS LAST READ: ' + ctx.teamRead + '. Coach within this plan, BUT check the minimap first: if the blue icons are no longer doing this, the plan has changed and this line is stale. Never push the player toward a site their team has already left, report the new plan in teamRead and coach the plan you can actually see.' : 'No current team read: read the minimap and report teamRead in STATE when you can see what the team is doing.'}

${predictBlock}READ THE HUD
- Round and score: top-center, plus the round timer (read it, it sets the stage, see ROUND TIMELINE) and whether it is buy phase.
- KILL FEED, top-right: the factual record of who killed whom, in order. This is the single most reliable thing on screen for what ACTUALLY happened, so use it instead of guessing: it tells you the man advantage, whether a teammate got traded, whether the player got the opening pick, and what killed them. Read it every frame.
- MINIMAP markers: red icons are enemies seen RIGHT NOW, question marks are last-known-position pings (an enemy was there, may have moved), and the spike icon shows where the spike is. These are given to you for free, so use them rather than assuming enemy positions.
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
${ctx.deathReviewDone ? 'THE PLAYER IS DEAD AND THE DEATH REVIEW IS ALREADY DONE. They are spectating and cannot act on anything this round, so more tips are pure noise over someone watching a killcam. Reply with exactly SKIP (still report STATE so the app can see when they respawn). Do not explain the death again, do not offer things to watch for, do not coach the teammate they are spectating. Just SKIP until they are alive again.\n' : ''}BUY PHASE IS DIFFERENT: hold a HIGHER bar. During the buy phase (barriers up, pre-round) only speak when you have a genuinely high-level, SPECIFIC setup call worth making, tied to what you can actually read on the minimap or the buy: a real default or exec plan, a concrete crossfire or off-angle setup, a util line-up for this site, a clear economy read (force, save, half-buy mistake). If the only thing you would say is generic ("group up", "play as a team", "communicate", "get ready", "hold your angles", "stay with the group", "wait for your team", "stay tight and don't push alone", "don't go in alone"), SKIP instead. A player does not need a coach to tell them to group up in spawn. Generic buy-phase filler is worse than silence, so when the buy read is not sharp, say nothing and wait for the round to go live.
YOU OVERUSE ONE PIECE OF ADVICE. Across a real session, 14 of the 23 tips a player saw were some version of "stay tight and wait for your team", twice almost word for word, and three of them landed in the first 21 seconds of the same buy phase. That advice is correct, which is exactly why it is so easy to keep giving, and a player who hears it every round learns nothing and stops reading the overlay. "Do not push alone" is a starting point, not a coaching session. If the honest read is that they should wait, say it ONCE, then find the next thing: what the util should do this round, where the enemy economy is, which angle actually needs clearing first, what their last death taught them, when the tempo should change. If you have already given that advice recently and nothing new is worth saying, SKIP.
If the screen is NOT live gameplay (main menu, lobby, agent select, loading screen, career or collection page, range with no match), reply with exactly LOBBY.

${spectatorLine}${aliveLine}${deathWhereLine}${deathLine}${roundLostLine}${enemyBlock}${memoryBlock}${transLine}${focusLine}CURRENT MATCH STATE (trust this, do not re-derive it every frame):
- Agent: ${ctx.agent || 'Unknown'} | Map: ${ctx.map || 'Unknown'} | Side: ${ctx.side || 'Unknown'}
- Mode: ${modeLine}
- Round: ${ctx.roundNumber || 'Unknown'} | Score: ${ctx.teamScore || 0}-${ctx.enemyScore || 0} | Phase: ${ctx.phase || 'Unknown'} | Clock: ${ctx.clock || 'read it from the timer'}
- Spike: ${ctx.spike ? ctx.spike + (ctx.spikeSpot ? ' at ' + ctx.spikeSpot : '') : 'not planted / unknown'}
- Last kill feed read: ${ctx.killFeed || 'nothing noted'}
- Player location (read from the minimap a few seconds ago): ${ctx.playerSpot || 'Unknown'}${ctx.playerSpotVerified ? ' (this one was resolved from the minimap coordinates, it is reliable)' : ''}
- Credits: ${ctx.playerCredits == null ? 'Unknown' : ctx.playerCredits} | Alive: ${ctx.playerAlive === false ? 'No' : 'Yes'} | Deaths in a row: ${ctx.consecutiveDeaths || 0}${ctx.playerAlive === false ? '\n- THE PLAYER IS DEAD RIGHT NOW. They cannot move, peek, rotate, buy, or use util this round. The ONLY valid tips are why they died and what to change, or what to watch and learn while spectating. Any tip telling a dead player to act is automatically wrong.' : ''}
- Teammates alive: ${ctx.teammatesAlive == null ? 'Unknown' : ctx.teammatesAlive} | Enemies alive: ${ctx.enemiesAlive == null ? 'Unknown' : ctx.enemiesAlive}${ctx.teammatesAlive === 0 && ctx.playerAlive !== false ? ' | THE PLAYER IS SOLO, this is a clutch' : ''}${spikeBlock}${scoreMood}${mapBlock}${patchBlock}${habitBlock}${delayBlock}${locationGuard}${abilityGuard}${deathFacts}

RECENT TIPS (do not repeat these word for word; if the SAME mistake is still happening and the advice matters, give it again in FRESH wording and mark the repetition, "still", "again", "third time now", important advice bears repeating, lazy copies do not):
${recent}
THESE ARE YOUR OWN WORDS, SO STAND BEHIND THEM. If the player did what you just told them to do and it went badly, that is YOUR call to own, never their mistake to be scolded for. In a real session this coach said "take an aggressive off-angle on B Main", the player took it, died, and was then told they died "because you took an aggressive off-angle", the player followed instructions and got blamed for it, and nothing destroys trust faster. When a play you recommended fails, say so plainly and adjust: "that off-angle got read, they were already holding it, so next round take it later or from the other side". If you cannot own it and give the adjustment in one sentence, coach something else entirely.
${lastShown ? 'NEVER REPEAT BACK TO BACK: the last tip shown ("' + lastShown + '") is still on the player\'s screen. Your next tip must either make a DIFFERENT point entirely, or, only if the same mistake is genuinely still happening and urgent, say it in completely fresh words with escalation ("still", "again", "third time now"). A tip that echoes the previous tip\'s advice or wording gets dropped by the app and wastes the slot, so when the only honest tip would be that repeat, prefer SKIP.\n' : ''}
${Array.isArray(ctx.badTips) && ctx.badTips.length ? 'The player rejected these tips repeatedly (3 or more times), NEVER give this advice or anything close to it again:\n' + ctx.badTips.slice(0, 6).map((t) => '- ' + t).join('\n') + '\n' : ''}
${Array.isArray(ctx.tipFeedback) && ctx.tipFeedback.length ? 'PLAYER FEEDBACK on past tips, their own words on why a tip missed. Learn from these, the reasons matter more than the tips:\n' + ctx.tipFeedback.slice(-6).map((f) => '- "' + String(f.text || '').slice(0, 90) + '" the player said: "' + String(f.reason || '').slice(0, 150) + '"').join('\n') + '\n' : ''}Recent topics: ${topics}. Prefer covering a DIFFERENT one (positioning, utility, aim, rotation, spike, teamwork, mental) unless a repeated mistake demands a repeat.
${ctx.overusedTheme
  ? `YOU HAVE WORN THIS SESSION'S ADVICE DOWN TO ONE IDEA: ${ctx.overusedTheme}. More than half of the tips this player has actually SEEN say it. It may well be true every time, which is exactly why it is easy to keep saying, but a player who hears the same sentence every round stops reading the overlay and learns nothing new. Do not say it again this frame, even in different words. Coach something else that is also true right now: utility timing, the economy, crosshair placement, what the minimap is showing, the tempo of the round, what their last death taught them, or what their team is doing that they could join. If the only honest thing to say is the worn-out idea, reply SKIP instead and let it land properly next time.\n`
  : ''}
${Array.isArray(ctx.blockedPlays) && ctx.blockedPlays.length
  ? `THESE PLAYS ARE BLOCKED THIS FRAME: ${ctx.blockedPlays.join(', ')}. You have just given them, so the app WILL drop a tip that recommends them again and the player will hear nothing at all. This is not a style note, it is a hard filter. In one real session a quarter of everything written was thrown away this way: 31 tips said "trade partner" straight after a trade tip, 12 more said hold tight. Coach something genuinely different, util timing, tempo, economy, crosshair placement, what the minimap is showing, what their last death taught them, or reply SKIP if nothing else is true.\n`
  : ''}

${agentKitBlock(ctx.agent)}

OUTPUT
Line 1 is the tip: one plain sentence, 8 to 22 words, ending with a period. Talk like a chill, sharp teammate in the player's ear, casual and clear, not stiff or formal, plain everyday words a Silver player gets instantly. Still say the PLACE and the ACTION ("hold the Hookah door and let them cross into you", never "play safer"), just say it like a person, not a textbook. No quotes, no "Tip:", no markdown, no preamble, no jargon the player would have to look up. Use commas and periods, never dashes. Always finish the sentence; never end on a preposition, article, conjunction, or possessive. If it is live gameplay with nothing new worth saying, line 1 is exactly SKIP. If it is not live gameplay at all, output ONLY the word LOBBY and nothing else.
VARY THE COACHING. You lean on a few stock recommendations, above all "set up a crossfire", and re-serve them with new wording on a new site. A player who hears "hold a crossfire" every other round stops listening. Before you repeat a play you have already given, ask whether the frame actually calls for something else: crosshair placement, timing and tempo, util usage, trading, spacing, when to give ground, when to take space, economy, or a habit you can see them repeating. The recent tips are listed below, so treat their ADVICE, not just their wording, as used up.
COACH LIKE AN ACTUAL COACH, NOT A HINT BOT. Every tip should teach something a Silver or Gold player would not already know, or catch a real mistake they are making right now. Give the REASON baked in, not just the instruction: "swing wide off Heaven so their close angle cannot trade you" beats "swing wide". Bad tips you must NOT give: vague filler anyone knows ("play smart", "aim better", "be careful", "watch your positioning", "communicate with your team"), and stating the obvious ("shoot the enemy", "you have the spike"). If your tip would make a Radiant nod because it is genuinely sharp, it is good; if it sounds like a loading-screen hint, it is filler, so SKIP instead. One specific, correct, reasoned tip per real moment beats a stream of generic ones.
When (and ONLY when) the tip explains why the player died or why the round was lost, line 1 starts with exactly "DEATH: " before the sentence. The app renders those as a special review card, so never use the marker on ordinary tips and never skip it on a death or round review.
${langReminder}

Then, for any live-gameplay frame (including SKIP), add a second line reporting what the HUD actually shows, null for anything unreadable, never guess:
STATE: {"side":"attack","phase":"active","round":5,"clock":"1:12","team":3,"enemy":1,"credits":4200,"hp":87,"alive":true,"aliveTell":"own rifle and HP 87 bottom center","mates":3,"foes":2,"weapon":"Vandal","map":"Ascent","mode":null,"mmPos":[0.48,0.2],"locLabel":"Mid Top","playerSpot":null,"enemySpot":null,"push":null,"pushOnSite":null,"spike":null,"spikeSpot":null,"killFeed":null,"teamRead":null,"note":null}
- side: during the buy phase the banner at the TOP of the screen says ATTACKING or DEFENDING, read it there first, it is authoritative. Otherwise "attack" if your team carries or bought the spike, "defense" if you see a defuser or you are holding sites, else null. Getting the side wrong is the single worst mistake you can make, every tip built on it turns into anti-coaching, so report null over a guess. THE HALVES DEPEND ON THE MODE: in Unrated and Competitive the starting side holds through round 12, flips for rounds 13 to 24, and only overtime (round 25+) alternates. In SWIFTPLAY halves are 4 rounds: the starting side holds rounds 1 to 4, flips for rounds 5 to 8, and a 4-4 sudden death round 9 must be read from the banner. If the round number puts the match past halftime for the mode and you knew the first-half side, report the flipped side even when the frame alone is ambiguous.
- mode: the queue, ONLY when it is actually printed on screen ("SWIFTPLAY", "COMPETITIVE", "UNRATED" on the agent select header, the loading screen, the scoreboard header, or the end of round banner). Report exactly what you read, else null, never infer it. The mode decides when sides swap, so a wrong mode flips every later side call.
- locLabel: THE GAME TELLS YOU WHERE THE PLAYER IS, SO READ IT. Just above or beside the top-left corner of the minimap, Valorant prints the player's CURRENT location as text, like "Mid Top", "A Lobby", "B Market", "Attacker Side Spawn". Copy that text EXACTLY as printed, including the site letter. Do not translate it, do not shorten it, do not substitute a callout you think fits better. This is printed by the game, so it beats anything you could work out from the picture, and it is also how the app confirms which map is being played. Report null only when that label is genuinely not on screen.
- mmPos: THE MOST IMPORTANT FIELD FOR LOCATION. Where the player's own YELLOW/GOLD minimap arrow (the one with the vision cone, NOT the blue teammate icons) sits ON THE MINIMAP, as two decimals [across, down]. Treat the minimap box's top-left corner as [0,0] and its bottom-right corner as [1,1]: so [0.5,0.5] is the middle of the minimap, [0.5,0.1] is near the top edge, [0.9,0.5] is near the right edge. Just measure where the yellow arrow is in that box, you do NOT need to know the callout's name. The app converts these numbers into the correct callout using the real map data, which is far more reliable than naming the spot yourself. Report null ONLY if the minimap or the yellow arrow is genuinely not visible.
  IMPORTANT: only report mmPos if the minimap is in its normal fixed orientation (north up, the layout matching the map above). If the player uses a ROTATING minimap that spins as they turn, the numbers would be meaningless, so report null and fall back to playerSpot.
- playerSpot: a backup, plain-words location for when you cannot give mmPos ("A site", "B main", "mid", "attacker spawn"). Use ONLY callouts that exist on this map. Report null when you cannot tell, a guessed spot becomes a wrong callout later.
- phase: "buy" (barriers up), "active" (round live), "postplant" (spike down), "dead" (player dead or spectating), else null.
- clock: the round timer at TOP-CENTER exactly as shown ("1:12", "0:38"), the round counts down from 1:40, and after the plant it is the 45-second spike timer. Read it every active frame, it decides the stage and what advice fits, null only when it is truly unreadable.
- hp: the player's OWN health number at the BOTTOM-CENTER of the screen, as a number. This is the ground truth for whether they are alive, so read it before you decide anything else. If you can see it, report it (100, 87, 12). If it is genuinely not on screen, report null. Do not estimate it and do not carry over the last value you remember.
- alive AND aliveTell: DO THIS CHECK FIRST, BEFORE ANYTHING ELSE IN THE FRAME. Answer one question: can I see the player's OWN health number at the bottom-center of the screen, with their OWN weapon and ability icons at the bottom-left?
  YES, own HP and own loadout visible  -> alive: true,  aliveTell: what you saw ("own HP 87 and Vandal bottom left").
  NO  -> the player is DEAD and spectating a teammate -> alive: false, aliveTell: the dead tell you saw.
  THE HP NUMBER DECIDES IT. If you reported an hp number above, the player is ALIVE, full stop, so alive must be true. Never report alive:false in the same breath as a readable health number, that combination is self contradictory and it is how a living player gets coached as a corpse. Only report alive:false when there is NO own-health number on screen AND you can name a real dead tell.
  The dead tells, any ONE of these is enough, you do not need two: a teammate's NAME shown at the bottom-left instead of your own loadout, the word "Spectating" anywhere, a death recap or killcam, the greyed-out observer HUD, a "You died" or respawn banner, or simply no HP number at the bottom-center at all.
  READ THESE EXACT STRINGS, THEY ARE THE MOST COMMON MISS. If the bottom-left shows a player PORTRAIT and NAME above the words "SWITCH PLAYER", the player is DEAD and spectating that person. If a panel in the upper right says "KILLED BY" above an agent name, they are DEAD. A "COMBAT REPORT" panel with an incoming damage total is the same story.
  WHEN SPECTATING, THE HEALTH NUMBER AT THE BOTTOM IS NOT THEIRS, it belongs to the teammate being watched, so a healthy-looking 100 there proves nothing. Report hp: null and alive: false, and say in aliveTell who is being spectated. Reporting a spectated teammate's health as the player's own is the single most damaging mistake in this whole format, because it makes a real death look like it never happened.
  aliveTell must be a SHORT phrase naming the actual evidence, never a guess and never empty. Writing the evidence down is what makes this read accurate, so always fill it in.
  NOT death, do not be fooled: a flashbang whiteout, a smoke, a dark corner, a scoped-in view, or a blurry frame. In those the HP number is usually still there. If the frame is truly unreadable, repeat the previous frame's value and say so in aliveTell ("unreadable, kept previous").
  This is the single most important field in the whole report. A dead player cannot peek, rotate, buy, or use util, so every tip built on a wrong alive read is nonsense the player will notice immediately.
- team, enemy, round: READ THE TWO SCORE DIGITS at the TOP-CENTER of the screen, one either side of the round timer. team is YOUR score (your team's side of the timer), enemy is theirs. Then round = team + enemy + 1, worked out from the digits you actually read.
  NEVER INFER THE ROUND FROM A BANNER. "LAST ROUND BEFORE SWAP", "FIRST ROUND OF HALF", "MATCH POINT" and the like tell you WHERE you are in the match, not WHICH round number it is, and the number differs by mode: a swap happens after round 4 in Swiftplay but after round 12 in Unrated and Competitive. Reading "last round before swap" and reporting round 12 in a Swiftplay game is exactly the mistake to avoid; it was reported as round 12 with a 6-5 score when the screen actually showed round 4. If you cannot read the score digits, report all three as null rather than deducing them from a banner, the score, or how far into the match it feels.
  The score digits are also how you avoid inventing a scoreline: a player winning 3-1 who is told they are losing 3-9 stops trusting everything else you say.
- credits: only during the buy phase when the number is readable.
- mates: how many OTHER teammates are alive right now (0 to 4); foes: how many enemies are alive (0 to 5). Read the agent portraits along the top HUD bar, dead players show darkened or crossed out. These numbers decide what advice is even possible, read them carefully.
- weapon: whatever is in the player's hands right now, "Knife" counts and matters.
- map: CHECK THIS EVERY FRAME AND BE HONEST, it is the field the most other things depend on. Read the minimap SHAPE and the site labels, not what you expected: Breeze is wide and open with a big round A and a long snake-shaped B, Ascent is compact with a central mid and A/B either end, Bind has two teleporters and no mid, Haven and Lotus have three sites, Icebox is tall and cluttered, Fracture is an H with attacker spawns on two sides, Split has a tight rope-heavy mid, Sunset and Pearl and Abyss and Corrode each have their own layout. If the map you are about to report does not MATCH the minimap in front of you, report what the minimap shows, not what you assumed earlier, and never carry a map over from a previous match. Report the map name ONLY when you are sure, read it from the minimap site layout (three sites A/B/C means Haven or Lotus, the only two 3-site maps; two sites plus teleporters and no mid means Bind). Report null when unsure, a wrong map locks in and breaks every later callout.
- enemySpot: where an enemy ACTUALLY IS according to the screen or the minimap, as a short callout like "A main", else null. Read the minimap properly, it hands you free information: a RED enemy icon is an enemy your team can see RIGHT NOW, and a QUESTION MARK is a last-known-position ping, an enemy was there recently but may have moved since. Say which kind it is in the note when it matters ("red icon B main", "question mark near mid"). Report null when nothing is marked, and never invent a position.
- NEVER START A TIP WITH A WORD THAT IS ALSO A MAP NAME. "Split the team two A and three B" was read by a real player as the coach naming the wrong map while they were on Bind, and it destroys trust in every callout that follows. Split, Breeze, Haven, Bind, Fracture, Pearl, Ascent, Lotus, Abyss, Summit and Icebox are map names first in this context, so say "send two A and three B", "divide your team", "break their sightline", "take it slow", never Split, Breeze or Fracture as ordinary verbs or nouns.
- push: the ENEMY COMMITMENT read, the single most valuable thing the minimap gives a defender. Format "<count> <site> <live|stale>", for example "3 B live" or "2 A stale". COUNT is how many separate enemy marks you can see clustered toward one site, SITE is A, B, C or Mid, and the last word is how fresh the information is: "live" when they are RED icons (visible to your team right now) and "stale" when they are QUESTION MARKS (last known, they may have moved). Only report it when the marks genuinely cluster toward ONE site, which is what commitment looks like; enemies spread across the map are a default, not a push, so report null. Also report null when nothing is marked. Never infer a push from sound or from what you expect, only from marks you can actually see, because this field decides whether the player abandons their position.
- pushOnSite: true when those enemy marks are already INSIDE the site (through the choke, on the plant area), false when they are still in the lobby or main approaching it, null when unclear or when push is null. This is the difference between "they are committed, rotate now" and "they are looking, hold your angle", so read it carefully.
- spike: the spike's state, from what is actually on screen. "planted" when the spike is down and its countdown is showing, "carried" when the player or a teammate is holding it, "dropped" when it is on the ground unheld, else null when you cannot tell.
- spikeSpot: WHERE the spike is when planted or dropped, as a short callout read from the spike icon on the minimap or from the screen, else null. This drives retake and defuse advice, so a guess here is worse than a null.
- killFeed: what the KILL FEED at the TOP-RIGHT just showed, in a few words: "we lost two in that trade", "player got the opening pick", "teammate traded them back", "enemy Jett killed two of ours". The kill feed is FACT, not inference, and it is the most reliable record of what actually happened, so read it every frame and use it for man advantage and for death reviews. Report null when nothing new is in the feed.
- teamRead: the team's CURRENT plan from the MINIMAP. Report it during the buy phase and the first seconds of a round, AND report it again the moment the plan visibly CHANGES: if the blue icons rotate to a different site, collapse back to retake, or abandon the hit, send the NEW read immediately ("rotated to A", "falling back to retake B"). A plan that is no longer true is worse than no plan, because the coach will keep pushing the player toward a site their team already left. Describe the plan relative to the player. The YELLOW icon is the player, the BLUE icons are the up-to-four teammates, so the read is always where the BLUE icons are versus where the YELLOW one is ("4 blue going A, player alone mid", "split A and mid", "spread default", "5 stacking B"). DIRECTION comes from the map labels: teammates near or moving TOWARD the A label are going A, toward B are going B, and "mid" is ONLY when icons sit between the two sites heading toward neither label (and only on a map that has a mid). Judge movement across frames, not one glance. If you cannot tell where they are heading, report null, a wrong read poisons the whole round's coaching. Null once the round is underway or when unreadable.
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
  // Health is the ground truth for being alive. A readable own-health number
  // and alive:false cannot both be true, and that contradiction is exactly how
  // a living player got coached as dead (and, with the death-silence rule, got
  // the coach to shut up mid-round). Health wins, in code, not just in prose.
  const hp = num(s.hp);
  if (hp != null && hp >= 0 && hp <= 100) out.playerHp = Math.round(hp);
  if (typeof s.alive === 'boolean') out.playerAlive = s.alive;
  if (out.playerAlive === false && out.playerHp > 0) {
    console.log(`[coach] contradiction: alive:false with hp ${out.playerHp}, trusting the health number`);
    out.playerAlive = true;
    out.aliveContradiction = true;
  }
  // The evidence behind the alive read. A named dead tell (a spectate label, a
  // teammate's name bottom-left, a killcam) is strong enough for the client to
  // register the death from ONE frame instead of waiting for a second one.
  if (str(s.aliveTell)) out.aliveTell = String(s.aliveTell).trim().slice(0, 60);

  // THE HEALTH NUMBER ON SCREEN IS NOT ALWAYS THE PLAYER'S OWN.
  //
  // "A readable health number means alive" holds right up until the player dies,
  // because the spectator HUD then shows the SPECTATED teammate's health in the
  // same place. The model reported alive:true with hp:100 while its own
  // aliveTell read "Spectating player candy with Ghost bottom left", and the
  // whole pipeline believed the number over the sentence.
  //
  // The damage was not a wrong field, it was that every genuine death review got
  // treated as a fabrication: the coach correctly said "you died", the state
  // said the player was at full health, and the tip looked like a hallucination
  // to everything downstream. Two sessions of real deaths were misfiled that way.
  //
  // So when the tell says spectating, the tell wins and the health number is
  // DROPPED rather than reassigned, because it belongs to somebody else and a
  // teammate's health passed off as the player's is worse than no reading.
  if (out.aliveTell && SPECTATE_TELL.test(out.aliveTell)
      && !(SPECTATE_FALSE_FRIEND.test(out.aliveTell) && !/\bswitch player\b|\bkill ?cam\b/i.test(out.aliveTell))) {
    if (out.playerAlive !== false || out.playerHp != null) {
      console.log(`[coach] spectator tell beats the health number: "${out.aliveTell}"`
        + ` (reported alive:${out.playerAlive} hp:${out.playerHp})`);
    }
    out.playerAlive = false;
    delete out.playerHp;          // that number is the spectated player's
    delete out.aliveContradiction;
  }
  if (num(s.mates) != null && s.mates >= 0 && s.mates <= 4) out.teammatesAlive = Math.round(s.mates);
  if (num(s.foes)  != null && s.foes  >= 0 && s.foes  <= 5) out.enemiesAlive   = Math.round(s.foes);
  if (str(s.weapon))    out.playerWeapon = str(s.weapon);
  if (str(s.map))       out.map          = str(s.map);
  if (str(s.enemySpot)) out.enemySpot    = str(s.enemySpot);
  // The enemy commitment read, parsed into parts the CLIENT can reason about.
  // Kept as a strict "<count> <site> <live|stale>" shape rather than free text
  // precisely so a guard can act on it: a tip that tells the player to hold
  // where they are while enemies are confirmed elsewhere has to be catchable.
  const push = str(s.push);
  if (push) {
    const m = push.match(/^\s*([1-5])\s+(A|B|C|Mid)\s+(live|stale)\s*$/i);
    if (m) {
      out.pushCount = Number(m[1]);
      out.pushSite  = m[2].toUpperCase() === 'MID' ? 'Mid' : m[2].toUpperCase();
      out.pushLive  = m[3].toLowerCase() === 'live';
      if (typeof s.pushOnSite === 'boolean') out.pushOnSite = s.pushOnSite;
    }
  }
  // Spike state drives retake / post-plant coaching, which outranks almost
  // everything else once it is down.
  const spike = str(s.spike);
  if (spike && /^(planted|carried|dropped)$/i.test(spike)) out.spike = spike.toLowerCase();
  if (str(s.spikeSpot)) out.spikeSpot = str(s.spikeSpot);
  // The kill feed is the factual record of what actually happened this round.
  if (str(s.killFeed)) out.killFeed = String(s.killFeed).trim().slice(0, 90);
  if (str(s.teamRead))  out.teamRead     = String(s.teamRead).trim().slice(0, 60);
  if (str(s.note))      out.playerNote   = String(s.note).trim().slice(0, 90);
  // The game mode decides the halftime math on the client (swiftplay halves
  // are 4 rounds, unrated/competitive are 12). Anything standard-shaped maps
  // to 'standard'; the client locks it only after two agreeing reads.
  const mode = str(s.mode);
  if (mode && /swift/i.test(mode)) out.gameMode = 'swiftplay';
  else if (mode && /comp|unrated|standard|premier/i.test(mode)) out.gameMode = 'standard';
  // Where the player's own minimap arrow sits ("B main", "mid"): feeds the
  // location context the next tips and death reviews are grounded in. The
  // analyze route overwrites this with the coordinate-resolved callout whenever
  // mmPos gives one, since that name is guaranteed to exist on this map.
  // The location label the GAME prints beside the minimap. Printed text, not a
  // judgement, so it is the most trustworthy location signal available and it
  // also fingerprints the map.
  if (str(s.locLabel)) out.locLabel = str(s.locLabel);
  if (str(s.playerSpot)) out.playerSpot = str(s.playerSpot);
  // The yellow arrow's position on the minimap, [across, down] in 0..1. Only a
  // well-formed pair inside the minimap box is kept; anything else is dropped
  // so a malformed read can never place the player somewhere invented.
  if (Array.isArray(s.mmPos) && s.mmPos.length === 2) {
    const [mx, my] = s.mmPos.map((v) => (typeof v === 'number' && isFinite(v) ? v : null));
    if (mx != null && my != null && mx >= 0 && mx <= 1 && my >= 0 && my <= 1) {
      out.mmPos = [mx, my];
    }
  }
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
    // One model for every frame (see AI.visionModel). The buy phase still gets a
    // little more answer budget and time, because it reports the pre-round team
    // read on top of the tip, but it is the SAME model as active play, so the
    // map and side reads stay consistent across the phase boundary and the locks
    // actually settle. Audio already spent up to 3.5s, so trim for that.
    const buyPhase     = String(context.phase || '').toLowerCase() === 'buy';
    const visionModel  = benchModel(req) || AI.visionModel;
    const answerBudget = buyPhase ? 300 : 220;
    const visionTimeout = (buyPhase ? (prevImage ? 17000 : 15000) : (prevImage ? 13000 : 11000)) - (audioBlock ? 2500 : 0);
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

    // MAP FINGERPRINT from the game's own printed location label. The model's
    // map opinion cannot be trusted on its own: it is wrong CONSISTENTLY, so a
    // rule that waits for it to contradict itself never fires (one session read
    // Ascent on all 78 frames). The label is independent evidence, so if the
    // label the game printed does not exist on the map the model claims, the
    // claim is dropped rather than allowed to drive callouts.
    if (outCtx.locLabel) {
      const claimed = outCtx.map || context.map;
      const fits = locator.labelFitsMap(claimed, outCtx.locLabel);
      if (fits === false) {
        console.log(`[coach] map claim "${claimed}" rejected: it has no "${outCtx.locLabel}"`);
        delete outCtx.map;
        outCtx.mapLabelConflict = true;
      } else if (fits === true) {
        // The label corroborates the map, so the location is known exactly.
        outCtx.playerSpot = outCtx.locLabel;
        outCtx.playerSpotVerified = true;
      }
    }

    // DETERMINISTIC LOCATION: the model reported WHERE the yellow arrow sits on
    // the minimap; the callout NAME comes from the map's real geometry, never
    // from the model's memory. This is what stops callouts belonging to another
    // map. Needs a locked map (the client only sends one after two agreeing
    // reads), so an unknown map simply keeps the model's own wording.
    const mapForSpot = outCtx.map || context.map;
    if (outCtx.mmPos && mapForSpot && !outCtx.playerSpotVerified) {
      const fix = locator.resolveSpot(mapForSpot, outCtx.mmPos[0], outCtx.mmPos[1]);
      if (fix) {
        // Cross-check against the model's own words. If it also named a spot and
        // the two disagree about which SITE the player is on, one of the reads is
        // wrong and we do not know which, so we keep neither rather than state a
        // confident lie. (A rotating minimap shows up exactly this way.)
        const claimed = String(outCtx.playerSpot || '').toLowerCase();
        const sup     = String(fix.superRegion || '').toLowerCase();
        const claimsOtherSite = claimed && /\b[abc]\b|\bmid\b/.test(claimed)
          && !claimed.includes(sup) && sup.length <= 3;
        if (claimsOtherSite) {
          console.log(`[coach] location conflict: coords say ${fix.spot}, model said "${outCtx.playerSpot}", dropping both`);
          delete outCtx.playerSpot;
        } else {
          outCtx.playerSpot = fix.spot;
          outCtx.playerSpotVerified = true;
          console.log(`[coach] location resolved: ${mapForSpot} ${JSON.stringify(outCtx.mmPos)} -> ${fix.spot} (${fix.precision})`);
        }
      }
    }
    delete outCtx.mmPos;   // raw coordinates are of no use to the client
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
    // Out of credits is a distinct, actionable state, not an outage. Report it
    // as such so the player is told the truth ("AI credits ran out") instead of
    // "temporarily down", which reads like a bug in the app.
    if (err && (err.credits || err.status === 402)) {
      return res.status(402).json({
        tip: '', context: {}, error: 'ai-credits',
        message: 'The coach AI is out of credits. Top up the OpenRouter account to resume AI tips.',
        retryInSec: creditsRetryIn(),
      });
    }
    console.error('[coach] analyze error:', err.message, err.stack && err.stack.split('\n')[1]);
    // Surface the PROVIDER's status code. Without it a revoked key (401), a
    // rate limit (429) and a genuine provider outage (5xx) are indistinguishable
    // from each other and from a bug in our own code, both to the client and to
    // anyone debugging from outside Railway. The status only, never the body,
    // which can echo request content.
    // A thrown analyze (AI provider rejected the request, a timeout, a parse
    // failure) is a real outage, NOT "no tip this frame". Returning a 200 here
    // made the client treat the empty body as a normal reply and sit silent,
    // with no coaching and no warning. A 5xx makes the client surface the
    // "coach's AI is temporarily down" notice and fall back to library tips.
    res.status(503).json({
      tip: '', context: {}, error: 'coach-unavailable',
      upstream: (err && err.status) || null,
      detail: (err && err.message) || null,
    });
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
// Last good rows PER QUEUE, so a rate-limited call falls back to what that
// queue last returned instead of reading as an empty queue. Held longer than
// the match cache: stale games are far better than a queue vanishing.
const QUEUE_FALLBACK_MS = 60 * 60 * 1000;
const queueCache = new Map();     // riotId|mode|queue -> { rows, at }

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
    cacheSet(rankHistoryCache, key, { at: Date.now(), data }, 500);
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
// One cache entry now carries BOTH the badge and the roster, because they come
// from the same match-detail call. Fetching that detail twice for two features
// would double the upstream calls against a rate limit that has already caused
// queues to vanish from the stats view.
const matchMvpCache = new Map();   // matchId -> { mvp, team } | null

/** Total rounds from a "13-10" scoreline; ACS is per round. */
function roundsOf(score) {
  const m = /^s*(d+)s*-s*(d+)s*$/.exec(String(score || ''));
  return m ? Number(m[1]) + Number(m[2]) : 0;
}

/**
 * One match-detail call, serving both the MVP badge and the team roster.
 *
 * Callers go through this directly. Convenience wrappers for "just the mvp" and
 * "just the team" existed briefly and were a trap rather than a courtesy: they
 * called this WITHOUT the round count, and since the result is cached per match
 * id, whichever wrapper ran first would have frozen an ACS of null into the
 * cache for the other. Deleted before that could happen. Rounds come from the
 * scoreline the match list already parsed.
 */
async function matchDetail(region, matchId, name, tag, rounds = 0) {
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

    // The player's own side, so the stats view can show who they actually
    // played with. Riot ID and agent are what identifies a teammate to a
    // player: "the Sova" means nothing three games later, "Fade#EUW" does.
    // The player themselves is marked rather than removed, so the roster reads
    // like the in-game scoreboard.
    // Rounds played, taken from THIS payload rather than threaded in from the
    // caller. The scoreline was being passed down and arriving as 0, and rather
    // than chase why through two layers, the number is derived where the data
    // already is. ACS is combat score per round, so without it every player
    // reads null and the scoreboard ordering below silently flattens.
    const teamsArr = Array.isArray(d.teams) ? d.teams
      : (d.teams && typeof d.teams === 'object' ? Object.values(d.teams) : []);
    let played = 0;
    for (const t of teamsArr) {
      const won = (t && t.rounds && (t.rounds.won != null ? t.rounds.won : t.rounds.win));
      const alt = t && (t.rounds_won != null ? t.rounds_won : t.won_rounds);
      const n = won != null ? won : alt;
      if (typeof n === 'number') played += n;
    }
    if (!played) played = rounds;   // scoreline from the caller, if it had one

    const team = players
      .filter((p) => teamOf(p) === teamOf(me))
      .map((p) => ({
        name:  [p.name, p.tag].filter(Boolean).join('#') || 'Unknown',
        agent: (p.agent && p.agent.name) || p.character || (p.character && p.character.name) || null,
        kills: (p.stats && p.stats.kills) | 0,
        deaths: (p.stats && p.stats.deaths) | 0,
        assists: (p.stats && p.stats.assists) | 0,
        // ACS is combat score per ROUND, using the count derived above from
        // this payload. It was threaded in from the caller first and arrived as
        // 0 every time, which read as "the API has no score" when the score was
        // there all along, so it is now taken from where the data already is.
        acs: played > 0 && p.stats && p.stats.score != null
          ? Math.round((p.stats.score | 0) / played)
          : null,
        me: p === me,
      }))
      // Scoreboard order: best combat score first, as the game shows it.
      .sort((a, b) => (b.acs || 0) - (a.acs || 0));

    const detail = { mvp, team };
    cacheSet(matchMvpCache, matchId, detail, 600);
    return detail;
  } catch (e) {
    console.log('[coach] match detail lookup failed:', matchId, e.message);
    return null;
  }
}

// ─── Per-round deaths, for checking what the coach thought it saw ────────────
// The AI log works out when the player died by reading the screen, and it is
// wrong in both directions: measured against this endpoint it missed 3 deaths in
// one session and invented 1 in another. Riot knows the answer exactly, so this
// exposes it: every death, the round it happened in, and who did it.
//
// Deliberately its own route rather than folded into matchDetail, which caches
// { mvp, team } per match id. Adding a field to a cached shape is how a stale
// entry starts serving nulls for something it never fetched.
const matchDeathsCache = new Map();   // matchId -> { rounds, deaths } | null

/** Kill events from a v4 match, whatever shape they arrive in. */
function killEventsOf(d) {
  if (Array.isArray(d && d.kills)) return d.kills;
  // Older and alternate shapes nest them per round. Flattened rather than
  // trusted to exist, so a payload change degrades to "no data" instead of
  // throwing inside a route.
  const out = [];
  for (const r of (Array.isArray(d && d.rounds) ? d.rounds : [])) {
    for (const s of (Array.isArray(r.stats) ? r.stats : [])) {
      for (const k of (Array.isArray(s.kill_events) ? s.kill_events : [])) out.push(k);
    }
  }
  return out;
}

const whoIs = (x) => (x && typeof x === 'object')
  ? [x.name, x.tag].filter(Boolean).join('#') || x.puuid || null
  : (typeof x === 'string' ? x : null);

// GET /api/coach/match-deaths?matchId=...&username=Name%23TAG
router.get('/match-deaths', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
  if (!process.env.HENRIKDEV_API_KEY) return res.json({ error: 'No stats provider configured.' });

  const matchId = String(req.query.matchId || '').trim();
  const username = String(req.query.username || '');
  if (!matchId) return res.json({ error: 'No match id.' });
  if (!username.includes('#')) return res.json({ error: 'Riot ID must be Name#TAG.' });
  const [name, tag] = username.split('#').map((s) => s.trim());

  const cacheKey = matchId + '|' + username.toLowerCase();
  if (matchDeathsCache.has(cacheKey)) return res.json(matchDeathsCache.get(cacheKey));

  try {
    const enc = encodeURIComponent;
    const acct = await henrikGet(`/valorant/v2/account/${enc(name)}/${enc(tag)}`);
    const region = acct.json && acct.json.data && acct.json.data.region;
    if (!region) return res.json({ error: 'Could not resolve the account region.' });

    const md = await henrikGet(`/valorant/v4/match/${region}/${enc(matchId)}`);
    if (md.status === 429) return res.json({ error: 'Tracker rate limit, try again shortly.' });
    const d = md.json && md.json.data;
    if (!d) return res.json({ error: 'The tracker returned no match detail.' });

    const mine = (p) => String((p && p.name) || '').toLowerCase() === name.toLowerCase()
      && String((p && p.tag) || '').toLowerCase() === tag.toLowerCase();

    const events = killEventsOf(d);
    const deaths = events
      .filter((k) => mine(k.victim))
      .map((k) => ({
        round: typeof k.round === 'number' ? k.round + 1 : null,   // Riot counts from 0
        atMs: k.time_in_round_in_ms != null ? k.time_in_round_in_ms : null,
        killer: whoIs(k.killer),
        weapon: (k.weapon && (k.weapon.name || k.weapon.type)) || null,
      }))
      .sort((a, b) => (a.round || 0) - (b.round || 0));

    const rounds = Array.isArray(d.rounds) ? d.rounds.length : null;
    const out = {
      matchId, rounds, total: deaths.length, deaths,
      map: (d.metadata && (d.metadata.map && d.metadata.map.name)) || null,
      startedAt: d.metadata && (Date.parse(d.metadata.started_at) || d.metadata.game_start_millis) || null,
    };
    // When nothing parsed, say what the payload actually looked like rather than
    // reporting zero deaths, which is indistinguishable from a flawless game.
    if (!events.length) {
      out.error = 'No kill events in this payload.';
      out.shape = { top: Object.keys(d), round0: d.rounds && d.rounds[0] ? Object.keys(d.rounds[0]) : null };
    }
    cacheSet(matchDeathsCache, cacheKey, out, 200);
    res.json(out);
  } catch (e) {
    console.error('[coach] match-deaths failed:', e.message);
    res.status(500).json({ error: 'Match death lookup failed.' });
  }
});

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

    // ONE UPSTREAM FAILURE MUST NOT LOOK LIKE AN EMPTY QUEUE.
    //
    // The unrated view needs two upstream calls (unrated + swiftplay), which
    // doubles the exposure to HenrikDev's rate limit. This loop used to take
    // `sm.json.data` when it was an array and fall back to [] otherwise, never
    // checking the status, so a 429 or a 5xx on either call was indistinguishable
    // from "this player has no games in that queue". The queue then silently
    // disappeared from the merged view, and because the failure alternates
    // between the two calls, so did the symptom: the same account returned ten
    // swiftplay and no unrated on one request, then four unrated and no
    // swiftplay on the next.
    //
    // Now a failed queue is remembered as failed. On failure the last good rows
    // for that queue are reused when we have them, so a transient upstream
    // hiccup can no longer erase half the tab.
    const rows = [];
    const failedQueues = [];
    for (const q of MODE_QUEUES[modeKey]) {
      const qKey = key + '|' + q;
      const sm = await henrikGet(`/valorant/v1/stored-matches/${region}/${enc(name)}/${enc(tag)}?mode=${q}&size=10`);
      const arr = (sm.ok && sm.json && Array.isArray(sm.json.data)) ? sm.json.data : null;

      if (arr) {
        const fresh = arr.filter((m) => m && m.stats);
        for (const m of fresh) { m._queue = q; rows.push(m); }
        cacheSet(queueCache, qKey, { rows: fresh, at: now }, 800);
        continue;
      }

      failedQueues.push(q);
      console.warn(`[matches] ${q} lookup failed for ${username} (status ${sm.status}), falling back to cache`);
      const cached = queueCache.get(qKey);
      if (cached && now - cached.at < QUEUE_FALLBACK_MS) {
        for (const m of cached.rows) { m._queue = q; rows.push(m); }
      }
    }
    const byDate = (a, b) => (Date.parse(b.meta?.started_at || 0) || 0) - (Date.parse(a.meta?.started_at || 0) || 0);
    rows.sort(byDate);
    // The unrated view merges unrated + swiftplay. Taking the plain 10 most
    // recent means a run of recent unrated games can crowd swiftplay out
    // entirely, which is the reported bug (unrated tab shows no swiftplay). If
    // swiftplay games exist but none made the recency cut, reserve up to 3
    // slots for the most recent swiftplay so both queues stay visible.
    let chosen = rows.slice(0, 10);
    if (modeKey === 'unrated') {
      // The reservation has to run BOTH ways. It used to protect swiftplay
      // only, on the assumption that unrated is the queue that crowds. For a
      // player whose recent games are mostly swiftplay the imbalance simply
      // inverts: the ten most recent are all swiftplay and their unrated games
      // vanish from the tab that is supposed to show them. Whichever queue is
      // missing gets up to 3 reserved slots, so the merged view always shows
      // both when both exist.
      for (const q of ['swiftplay', 'unrated']) {
        const all = rows.filter((m) => m._queue === q);
        const shown = chosen.filter((m) => m._queue === q).length;
        if (shown === 0 && all.length) {
          const want = all.slice(0, Math.min(3, all.length));
          chosen = chosen.slice(0, 10 - want.length).concat(want).sort(byDate);
        }
      }
    }
    const matches = [];
    for (const m of chosen) {
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
    // MVP badges and the team roster resolve in parallel from the (permanent)
    // detail cache; a missing one is just null and fills in on a later refresh.
    // Both come from ONE detail call per match, so adding the roster costs no
    // extra upstream requests against a rate limit that has bitten before.
    await Promise.all(matches.map(async (m) => {
      const d = await matchDetail(region, m.id, name, tag, roundsOf(m.score));
      m.mvp  = d ? d.mvp : null;
      m.team = d ? d.team : null;
    }));

    // A result built while a queue was failing is degraded, so it is not worth
    // the full TTL. Backdating fetchedAt lets the next poll retry almost
    // immediately instead of serving an incomplete list for five minutes.
    const degraded = failedQueues.length > 0;
    const entry = {
      data: matches,
      fetchedAt: degraded ? now - (MATCHES_TTL_MS - 30 * 1000) : now,
      lastManualRefresh: wantsRefresh ? now : (hit ? hit.lastManualRefresh : 0),
    };
    cacheSet(matchesCache, key, entry, 500);
    res.json({ matches, fetchedAt: now, cached: false, partial: degraded || undefined });
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
// POST /api/coach/session-report
// COUNTS ONLY, NEVER CONTENT. How many tips a session produced, how many
// survived the gates, and which KIND of gate stopped the rest. That histogram is
// what exposed the repetition problem, the ability-vocabulary mismatch and the
// truncation false positive, and none of it needs a pixel or a word of what the
// player saw. Frames stay on the player's own machine, which is the whole point.
//
// The license key is hashed to 8 characters before it is stored, so repeat
// sessions can be told apart without keeping anything that identifies anyone.
// Failures here are silent by design: telemetry must never cost a player a tip.
router.post('/session-report', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });
    const hash = crypto.createHash('sha256').update(licenseKey).digest('hex').slice(0, 8);
    telemetry.record(req.body || {}, hash);
    res.json({ ok: true });
  } catch (e) {
    console.error('[telemetry] report failed:', e.message);
    res.json({ ok: false });
  }
});

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

    // THE SCOREBOARD, when the client could confirm the match was this session.
    // Tips only record what the coach chose to talk about, so grading on them
    // alone measures the coaching rather than the player: someone told to fix
    // their aim who then went 30/5 scored the same as someone told the same
    // thing who went 5/20. The client will not send this unless the map, the
    // agent and the timing all agreed, so it can be trusted as this match.
    const m = (req.body && req.body.match) || null;
    const matchBlock = m ? `
FINAL SCOREBOARD for this exact match (verified as the coached game, this is hard evidence and outranks everything else for the aim and impact scores):
- Result: ${String(m.result || '?').slice(0, 12)} ${String(m.score || '').slice(0, 10)}
- K/D/A: ${m.kills | 0}/${m.deaths | 0}/${m.assists | 0} (K/D ${Number(m.kd) || 0})
- ACS ${m.acs | 0}, ADR ${m.adr | 0}, headshot ${m.headshotPct | 0}%${m.grade ? `\n- Tracker grade for this match: ${String(m.grade).slice(0, 3)}` : ''}
CALIBRATE AGAINST REAL VALORANT NUMBERS, because "strong" means nothing without a scale and these were being read as ordinary. ACS: under 150 is poor, 200 is average, 250 is good, 300 is excellent, 350 and above is exceptional and belongs in the 90s. K/D: 0.8 is losing the duels, 1.0 is even, 1.3 is good, 1.8 and above is dominant. ADR: 120 is low, 160 is solid, 200 and above is carrying. Headshot: 15% is low, 25% is average, 30% and above is strong aim. A tracker grade of S or A is a standout performance.
Use these numbers. A strong scoreboard means the aim and impact scores should be high even if the coaching corrected a lot, and a weak one means they should be low even if the session was quiet. A player who topped the scoreboard does not get a mediocre aim or impact score because the coach found positioning habits to fix: score the CATEGORY, not the amount of advice given. Positioning and utility are where the corrections belong. Never restate the raw numbers back to the player in summary, strengths, weaknesses, or practice; they can already see their own scoreboard. Let the numbers set the SCORES and describe the habit behind them in words.
` : '';

    const prompt = `A Valorant player finished a coached session${ctx.map ? ' on ' + String(ctx.map).slice(0, 20) : ''}${ctx.agent ? ' playing ' + String(ctx.agent).slice(0, 16) : ''}${ctx.durationMin ? ', about ' + Math.round(ctx.durationMin) + ' minutes long' : ''}. These coaching tips were shown during it:\n${tips.join('\n')}\n${notesBlock}${matchBlock}\nReturn ONLY valid JSON, no markdown:\n{"impact":82,"positioning":54,"utility":61,"aim":77,"summary":"...","strengths":"...","weaknesses":"...","practice":"..."}\nThe four numbers above are FORMATTING ONLY, they are not this player's scores and copying them is a failure. Score each category independently, 0-100, and expect them to differ from each other: a session where every category lands on the same number almost never happens, so if you are about to return four identical scores, look again at which category the evidence actually separates. Use the range: 30s and 40s for a category that clearly cost them the game, 50s and 60s for below par, 70s for solid, 80s and 90s for genuinely strong. impact means round influence: opening picks, entries that created space, clutch attempts, multikills, and being part of the plays that decided rounds; a quiet passenger scores low even with a clean K/D. When OBSERVED FACTS are provided they are the primary evidence, they describe what the player actually did; the tips only show what the coaching focused on and do NOT prove the player did or failed anything. Many corrections in a category still suggests a lower score there, but never state the player did something unless an observed fact shows it. No signal for a category means a neutral 70-75, but a category with real evidence must move away from neutral in whichever direction the evidence points.
UNUSED UTILITY IS A FAULT, NOT THRIFT. Ending rounds with a full ability bar means value was thrown away, so it lowers the utility score. Never praise it as good resource management.
THIS IS THE POST GAME TALK. The player is reading it after the match is over, away from the game. They cannot picture a specific round or a specific spot on the map anymore, so replaying moments back at them is useless. NAME THE HABIT INSTEAD.
- WRONG (never write anything like this): "You repeatedly dry peeked Mid Top, B Site, and B Main without a trade partner." "You died at A Main three times." "You repeeked Hookah after your kill."
- RIGHT: "You're dry peeking a lot, taking duels without a flash or a teammate ready to trade." "Over-peeking is your biggest leak, you keep re-challenging the same angle after you win a fight." "You're over-extending on defense and dying before your team can help."
NEVER name a map location, a callout, a site, a round number, or a specific moment ANYWHERE in summary, strengths, weaknesses, or practice. Describe the PATTERN, using the words a real coach uses: dry peeking, over-peeking, re-peeking the same angle, no trade partner, over-extending, over-rotating, wide swinging, tunnel vision, crosshair placement, counter-strafing, spray control, util dumping, saving util too long, passive play, over-aggression, poor spacing, playing too far forward, not clearing angles, forcing on a bad economy.
summary: 3-4 sentences spoken straight TO the player like a coach right after the game, honest and encouraging. How the session went, the clearest strength, the single biggest leak in plain habit terms, and what changes next game.
strengths: 1-2 sentences naming what they genuinely did well, as a habit worth keeping.
weaknesses: 1-2 sentences naming the ONE or TWO habits costing them the most. Be direct and specific about the habit, never about the location.
practice: 2-3 sentences of concrete homework for getting better at that habit: what to actually DO before or during the next games. Give a real routine, for example a range or deathmatch warmup with a specific focus, a rule to hold themselves to for a whole game ("never take a duel unless a teammate can trade you"), or a habit to consciously repeat. Make it something they can start today, not vague advice like "practice more".
Ground everything strictly in the tips and observed facts, invent nothing. Use commas and periods, never dashes.`;

    let out = null;
    try {
      // json mode: the tip sanitiser is for prose and has no business touching
      // a JSON payload. The timeout lives inside textInfer so a slow reasoning
      // model counts as a strike and falls back instead of failing the grade.
      const raw = await textInfer(prompt, 420, { json: true, timeoutMs: 24000 });
      trackCall(licenseKey);
      const parsed = JSON.parse(String(raw).replace(/```json|```/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '').trim());
      const n = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      out = {
        impact: n(parsed.impact != null ? parsed.impact : parsed.economy), positioning: n(parsed.positioning),
        utility: n(parsed.utility), aim: n(parsed.aim),
        summary:    sanitize(String(parsed.summary    || '')).slice(0, 700),
        strengths:  sanitize(String(parsed.strengths  || '')).slice(0, 400),
        weaknesses: sanitize(String(parsed.weaknesses || '')).slice(0, 400),
        practice:   sanitize(String(parsed.practice   || '')).slice(0, 500),
      };
    } catch (e) {
      console.warn('[coach] score-session AI failed, using heuristic:', e.message);
    }

    // Heuristic fallback when the AI grade is unavailable. It still has to be
    // real coaching: the old version told the player to go read their own tips,
    // which is not advice. Work out which area drew the most corrections and
    // speak to that habit, with homework attached.
    if (!out || !out.strengths) {
      const count = (re) => tips.filter((t) => re.test(t)).length;
      const score = (c) => Math.max(45, 80 - c * 6);
      const counts = {
        impact:      count(/entry|trade|clutch|first blood|opening|multi|alone with no/i),
        positioning: count(/position|angle|peek|reposition|spot|corner|off angle/i),
        utility:     count(/util|smoke|flash|molly|recon|wall|drone|ability/i),
        aim:         count(/aim|crosshair|spray|headshot|strafe|whiff/i),
      };
      const COACHING = {
        positioning: {
          weak: 'Positioning is costing you the most. You are taking duels from spots where nobody can trade you, and re-challenging angles you already won.',
          fix:  'Give yourself one rule for a whole game: never take a duel unless a teammate can trade you. After every kill, move somewhere new before you peek again.',
        },
        aim: {
          weak: 'Your aim is the leak here, mostly crosshair placement and spraying when you should be tapping.',
          fix:  'Ten minutes of deathmatch before you queue, head level only, focusing on holding your crosshair at head height as you move rather than on kills.',
        },
        utility: {
          weak: 'Utility is the gap. You are either holding abilities until they expire or dumping them with no plan behind them.',
          fix:  'Pick one ability each round and decide out loud what it is for before you use it. Aim to finish every round with nothing left unused.',
        },
        impact: {
          weak: 'You are playing too passively to affect rounds, ending games as a passenger rather than someone who made things happen.',
          fix:  'Commit to being the one who makes first contact twice a game, with a flash or a teammate behind you. Taking space with support beats waiting for a fight to come to you.',
        },
      };
      const weakest = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      const strongest = Object.keys(counts).sort((a, b) => counts[a] - counts[b])[0];
      const LABEL = { impact: 'round impact', positioning: 'positioning', utility: 'utility use', aim: 'aim' };
      const c = COACHING[weakest];
      out = out || {
        impact:      score(counts.impact),
        positioning: score(counts.positioning),
        utility:     score(counts.utility),
        aim:         score(counts.aim),
        summary:    `${c.weak} Your ${LABEL[strongest]} held up well by comparison, so that is the part to keep. Fix the one habit above and the rest of your game follows it up.`,
        strengths:  `Your ${LABEL[strongest]} needed the least correcting this session, keep playing that part of your game the way you are.`,
        weaknesses: c.weak,
        practice:   c.fix,
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

    // EVERY QUEUE, NOT JUST COMPETITIVE.
    //
    // This asked for mode=competitive, so for a player whose recent games are
    // swiftplay or unrated it answered with whatever competitive match they
    // last played, which in a real account was a MONTH old. The session to
    // match link then correctly refused it every single time (different map,
    // different agent, month old timestamp), so no coached session ever got a
    // scoreboard. The guard was working; it was being fed the wrong match.
    //
    // No mode filter and a handful of rows, newest first. One upstream call,
    // which also keeps this off the rate limit that made the merged unrated
    // view flicker earlier. Anything irrelevant is rejected downstream by the
    // map, agent and timing checks, so casting wide here is safe.
    const sm   = await henrikGet(`/valorant/v1/stored-matches/${region}/${enc(name)}/${enc(tag)}?size=5`);
    const rows = Array.isArray(sm.json?.data) ? sm.json.data.filter((x) => x && x.stats) : [];
    rows.sort((a, b) => (Date.parse(b.meta?.started_at || 0) || 0) - (Date.parse(a.meta?.started_at || 0) || 0));
    const m = rows[0];
    if (!m) return res.json({ error: 'No recent match found yet. Matches appear a few minutes after they end.' });

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

const DETECTABLE_AGENTS = ['Jett','Reyna','Phoenix','Raze','Neon','Iso','Yoru','Sova','Breach','Skye','KAY/O','Fade','Gekko','Tejo','Omen','Brimstone','Viper','Astra','Harbor','Clove','Sage','Killjoy','Cypher','Chamber','Deadlock','Vyse','Waylay'];
const AGENT_WORD_RE = new RegExp(
  '\\b(' + DETECTABLE_AGENTS.map((a) => a.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') + ')\\b', 'gi');

/**
 * The agent a detection reply names, or null when it does not clearly name one.
 *
 * This was a substring search, and English is full of agent names: "the icons
 * are not visible at this moment" detected OMEN, "cannot read the ability bar
 * in this isolation view" detected ISO, "please check the message area"
 * detected SAGE. A wrong lock is expensive, because the ability gate then
 * validates tips against the wrong kit, while returning null costs only a
 * confirmation the player is asked for anyway.
 *
 * So the reply has to earn it: the prompt asks for one bare word, an exact
 * answer is taken, a short answer naming exactly one agent is taken, and prose
 * is refused. Prose is where every false positive lived.
 */
function detectAgentName(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return null;
  // KAY/O is the one canonical name that is not a plain word, so accept the
  // spellings a model actually returns for it.
  const text = raw.replace(/\bKAY[\s._-]?O\b/gi, 'KAY/O');
  const bare = text.replace(/[.!,;:"'`]+$/g, '').trim();

  const exact = DETECTABLE_AGENTS.find((a) => a.toLowerCase() === bare.toLowerCase());
  if (exact) return exact;

  if (bare.split(/\s+/).length > 5) return null;
  const hits = new Set((text.match(AGENT_WORD_RE) || [])
    .map((m) => DETECTABLE_AGENTS.find((a) => a.toLowerCase() === m.toLowerCase()))
    .filter(Boolean));
  return hits.size === 1 ? [...hits][0] : null;
}

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

    const cleanText = String(text || '').trim();
    const detected  = detectAgentName(cleanText);

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
// POST /api/coach/frame-chat
// "Why did I die here?" against a SINGLE frame from the AI decision log. Unlike
// /chat, this one is multimodal: the screenshot rides along, so the coach can
// look at the moment rather than reason from a text summary of it. The frames
// either side are attached too when available, since a death is usually
// explained by what was happening just before it.
router.post('/frame-chat', async (req, res) => {
  try {
    const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
    if (!licenseKey || !await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid license' });

    const body = req.body || {};
    const question = String(body.question || '').trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: 'No question' });

    const images = (Array.isArray(body.images) ? body.images : [])
      .filter((i) => typeof i === 'string' && i.length > 100)
      .slice(0, 3);
    if (!images.length) return res.status(400).json({ error: 'No frame' });

    const st = body.state || {};
    const shown = String(body.shown || '').slice(0, 300);
    const history = (Array.isArray(body.history) ? body.history : [])
      .slice(-8)
      .map((m) => `${m && m.role === 'assistant' ? 'Coach' : 'Player'}: ${String((m && m.content) || '').slice(0, 600)}`)
      .filter((l) => l.length > 8);

    const known = [];
    if (st.map) known.push(`map ${st.map}`);
    if (st.side) known.push(`playing ${st.side}`);
    if (st.roundNumber) known.push(`round ${st.roundNumber}`);
    if (st.teamScore != null && st.enemyScore != null) known.push(`score ${st.teamScore}-${st.enemyScore}`);
    if (st.clock) known.push(`clock ${st.clock}`);
    if (st.playerHp != null) known.push(`health ${st.playerHp}`);
    if (st.playerAlive === false) known.push('the player was dead / spectating');
    if (st.playerSpot) known.push(`at ${st.playerSpot}`);
    if (st.spike) known.push(`spike ${st.spike}${st.spikeSpot ? ' at ' + st.spikeSpot : ''}`);
    if (st.killFeed) known.push(`kill feed said: ${st.killFeed}`);
    if (st.playerNote) known.push(`noted at the time: ${st.playerNote}`);

    const prompt = `You are the player's Valorant coach, looking back at a saved moment from their match WITH them. ${images.length > 1 ? 'Several frames are attached in time order; the LAST one is the moment being asked about, the earlier ones are the seconds leading up to it.' : 'One frame is attached: the moment being asked about.'}

WHAT THE APP RECORDED AT THE TIME: ${known.length ? known.join(', ') : 'very little, so rely on the image'}.
${shown ? `THE TIP IT GAVE THEN: "${shown}"` : ''}
${history.length ? `\nTHE CONVERSATION SO FAR:\n${history.join('\n')}` : ''}

THE PLAYER ASKS: ${question}

Answer as their coach, talking about this exact moment.
- Look at the frame properly before answering: the minimap, the HUD, the kill feed at the top right, their health, what is in their hands, where enemies are marked.
- Ground every claim in what is actually visible or in the recorded facts above. If the frame does not show why something happened, say so plainly instead of inventing a reason. "I cannot tell from this frame" is a good answer when it is the true one.
- Be specific and practical: what happened, why it happened, and what to do differently. Do not lecture, and do not repeat the tip above word for word.
- 2 to 5 sentences, plain conversational English, no markdown, no lists. Use commas and periods, never dashes.`;

    const raw = await Promise.race([
      visionInfer(images, prompt, 420, false, AI.visionModel),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
    ]);
    trackCall(licenseKey, images.length);

    const reply = sanitize(stripThinking(String(raw || ''))).trim();
    if (!reply) return res.json({ error: 'The coach had no answer for that frame. Try asking differently.' });
    res.json({ reply: reply.slice(0, 1200) });
  } catch (e) {
    if (e && (e.credits || e.status === 402)) {
      return res.status(402).json({ error: 'ai-credits', message: 'The coach AI is out of credits.' });
    }
    console.error('[coach] frame-chat error:', e.message);
    res.status(503).json({ error: 'Could not reach the coach right now.' });
  }
});

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
            `- ${m.when ? m.when + ', ' : ''}${m.map || '?'} (${m.agent || '?'}${m.queue ? ', ' + m.queue : ''}): ${m.result || '?'} ${m.score || ''}, ${m.kills}/${m.deaths}/${m.assists}, ACS ${m.acs}, ADR ${m.adr}, HS ${m.headshotPct}%, rating ${m.rating}`).join('\n')
        + '\nALWAYS SAY WHICH MATCH YOU MEAN. When you refer to one of these games, name it: the map, the agent, and the result, for example "your Sunset loss on Jett" or "the 13-9 win on Bind this afternoon". "Your last game" and "that match" are useless to someone who has played five, and if two share a map the agent or the time tells them apart. If you are talking about a pattern ACROSS matches, say that explicitly instead ("across your last five, on defence you...").\n'
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
- ANSWER THE QUESTION THEY ACTUALLY ASKED, FIRST. This is the most important rule. If they ask a real Valorant question, the current meta, which agents are strong, how to use an ability, what to buy, how a map should be played, then give them the actual answer in the first sentence or two. Name real agents, real numbers, real specifics. Only after answering do you connect it to their game.
- NEVER deflect a genuine question into a lesson. Answering "what are the best agents in this meta" with "the meta does not matter for you, your positioning is the problem" is a failure, even when the positioning point is true. It reads as dodging, and the player came for an answer. Give them both: the answer they asked for, then the thing that actually moves their rank. "Right now Jett, Raze and Omen are the strongest picks. That said, none of them fix the thing costing you games, which is ..." is the shape to aim for.
- If a question genuinely has no factual answer you can stand behind, say so plainly in one sentence rather than substituting a lesson for it.
- Only discuss Valorant and the player's gaming performance. If asked about something truly unrelated, steer back to their gameplay in one friendly sentence.
- COACH LIKE THE BEST, in the second half of your reply: diagnose the ROOT CAUSE behind what they are asking (deaths usually trace to positioning, timing, or fighting without a trade partner before they trace to aim). Name the ONE highest-impact fix, then give a concrete drill or in-game habit to build it, for example 10 minutes of deathmatch focusing only on counter-strafe headshots, a minimap glance every 5 seconds, or reviewing one lost round per match and asking what info they had before the fight.
- Ground advice in proven Radiant and pro fundamentals: fight with a trade partner in view, clear angles in slices, use util before contact, take an off-angle once then move, keep economy discipline, reposition after kills.
- Combine their career stats with the match flow and this session's tips. The best answer ties a stat to a concrete example, and covers both aim and game sense, not just headshot rate.
- Be honest, do not praise a mistake as if it were good, and do not invent a mistake that is not there. Knife out while rotating through safe space is CORRECT (fastest movement), knife out where contact is possible is the mistake. Match abilities to their real purpose (Updraft and dashes are mobility, not tools to clear angles).
- Be concrete: name the exact habit or mistake and the fix, not generalities.
- 3 to 6 short sentences, under 150 words total. Plain text, no markdown, no lists. The reply has two jobs now, the answer and the coaching, so it gets a little more room, but do not ramble.
- Use commas and periods, never dashes.
- If you genuinely lack the information to answer, say what you'd need to see.`;

    // The timeout lives inside textInfer so a stalled reasoning model falls back
    // to instruct and still answers, instead of surfacing as "Chat failed".
    // Room for both halves of the reply (the answer, then the coaching) without
    // the second one getting truncated mid sentence.
    const ask = (p) => textInfer(p, 420, { timeoutMs: 18000 });

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
    // Same reasoning as analyze: without the provider's status this is not
    // diagnosable from outside Railway.
    res.status(500).json({ error: 'Chat failed', upstream: (e && e.status) || null, detail: (e && e.message) || null });
  }
});

module.exports = router;
module.exports.costStore   = costStore;
module.exports.globalStats = globalStats;
module.exports.mapState    = mapState;             // exported for tests
module.exports.trackCall   = trackCall;            // exported for tests
module.exports.detectAgentName = detectAgentName;  // exported for tests
module.exports.buildContextPrompt = buildContextPrompt;
// The models actually in use, so /health reports THIS rather than keeping its
// own copy of the defaults. It kept a separate copy and they drifted, which
// turned the one endpoint whose job is answering "what is live" into a thing
// that stated a model no code path could reach.
module.exports.telemetry  = telemetry;

/**
 * THE PROVIDER LAYER, shared with any future game's routes.
 *
 * Exported rather than extracted into its own module, deliberately. The
 * intention was to lift it into server/services/ai.js, but the members are not
 * contiguous: agentKitBlock, ROLE_BRIEF, SPECTATE_TELL and ANALYZE_SCHEMA sit
 * interleaved between them, and all four are Valorant prompt code. Pulling the
 * provider layer out cleanly would mean rearranging the prompt file around it,
 * on a server that is live and is the only thing standing between a paying user
 * and no coaching at all. Exporting achieves the actual goal, which is that a
 * second game never needs to EDIT this file, at none of the risk.
 *
 * What is shared here is not convenience, it is scar tissue. Each of these
 * exists because of a specific outage:
 *   visionInfer / textInfer  the reasoning-token guard, after a "flash" model
 *                            that reasons by default returned 0 tips and 0
 *                            STATE lines across 10 real frames
 *   creditsLookExhausted     the breaker, and the rate-limit distinction added
 *                            after a 429 mentioning "quota" was reported to a
 *                            player as an empty wallet
 *   sanitize                 dash removal, a hard rule in this product's copy
 * A second game re-implementing these would re-learn every one of them the
 * expensive way.
 */
module.exports.ai = {
  visionInfer,
  textInfer,
  sanitize,
  validateKey,
  creditsLookExhausted,
  creditsRetryIn,
};
module.exports.liveModels = () => ({
  provider:    AI.provider,
  visionModel: AI.visionModel,
  textModel:   AI.textModel,
});
