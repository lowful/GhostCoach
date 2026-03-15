'use strict';
const express  = require('express');
const supabase = require('../db/supabase');
const router = express.Router();

let genAI = null;
function getGenAI() {
  if (!genAI) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

// ─── Cost tracking (in-memory, resets on server restart) ──────────────────────
const costStore   = new Map();
const globalStats = { callsToday: 0, callsMonth: 0, costToday: 0, costMonth: 0, date: '' };
// Gemini Flash: ~$0.50/M input tokens, ~$3.00/M output tokens
// Est. 1200 input + 50 output tokens per call
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

const SMART_PROMPT = [
  'You are an Immortal/Radiant level Valorant coach analyzing live gameplay screenshots.',
  '',
  'Determine the game state and respond with EXACTLY one of these:',
  '- WAITING: Not a live Valorant match (menu, lobby, loading, queue)',
  '- ROUND_END: Post-round scoreboard or end-of-round results',
  '- ACTIVE_WAIT: Mid-combat and a tip was already given this encounter',
  '- PLAYER_DEAD|<tip>: Player is dead or spectating. Add ONE tip under 12 words after the pipe.',
  '- A short coaching tip for buy phase, positioning, rotation, or economy',
  '',
  'Economy: Full buy at 3900+ credits. Force buy round 2 after winning pistol. Save fully if team broke. Spectre is best force buy. Light shields on pistol round.',
  'Positioning: Off-angles beat common angles. Reposition after every kill. Never re-peek the same angle twice in a row.',
  'Common mistakes: Peeking one by one instead of trading. Not using utility first. Ego peeking. Not checking minimap. Rotating too early or too late.',
  'Tip rules: Under 12 words. No em-dashes or long dashes. Commas and periods only.',
].join('\n');

const ROUND_SUMMARY_PROMPT = [
  'You are analyzing a Valorant round that just ended. Return ONLY valid JSON, no markdown:',
  '{"round_result":"win","things_done_well":["praise under 12 words"],"things_to_improve":["advice under 12 words"],"key_tip_for_next_round":"tip under 12 words","performance_rating":3}',
  'round_result: win, loss, or unknown. 1-3 items per array. performance_rating 1-5. No em-dashes.',
].join('\n');

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

async function geminiCall(imageB64, prompt, maxTokens) {
  const model = getGenAI().getGenerativeModel(
    { model: 'gemini-1.5-flash', generationConfig: { maxOutputTokens: maxTokens || 100, temperature: 0.3 } },
    { apiVersion: 'v1' }
  );
  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { mimeType: 'image/jpeg', data: imageB64 } },
  ]);
  return sanitize(result.response.text() || '');
}

// POST /api/coach/analyze  — raw binary JPEG body
router.post('/analyze', async (req, res) => {
  const licenseKey  = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  const combatGiven = req.headers['x-combat-tip-given'] === 'true';
  const recentRaw   = req.headers['x-recent-tips'] || '';
  const recentTips  = recentRaw ? recentRaw.split('||').filter(Boolean) : [];

  if (!licenseKey) return res.status(400).json({ error: 'X-License-Key header required' });
  if (!await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid or expired license key' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No image data' });

  const t0 = Date.now();
  let prompt = SMART_PROMPT;
  if (combatGiven) {
    prompt += '\n\nNOTE: A tip was already given for the current combat engagement. If combat is still ongoing, respond with ACTIVE_WAIT.';
  }
  if (recentTips.length) {
    prompt += '\n\nRecent tips already given (do NOT repeat):\n' + recentTips.map((t, i) => (i + 1) + '. ' + t).join('\n');
  }

  try {
    const tip = await Promise.race([
      geminiCall(req.body.toString('base64'), prompt, 100),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout')), 8000)),
    ]);
    trackCall(licenseKey);
    console.log('[coach] ' + licenseKey.slice(0, 8) + '... -> "' + (tip || '').slice(0, 50) + '" (' + (Date.now() - t0) + 'ms)');
    res.json({ tip: tip || '' });
  } catch (err) {
    console.error('[coach] analyze error:', err.message);
    res.json({ tip: '' }); // silent skip
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
    const model = getGenAI().getGenerativeModel(
      { model: 'gemini-1.5-flash', generationConfig: { maxOutputTokens: 600 } },
      { apiVersion: 'v1' }
    );
    const result = await Promise.race([
      model.generateContent([{ text: sysPrompt }, { text: 'Generate JSON.' }]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
    trackCall(licenseKey);
    const text = sanitize(result.response.text() || '');
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (err) {
    console.error('[coach] match summary error:', err.message);
    res.status(500).json({ error: 'Summary failed' });
  }
});

module.exports = router;
module.exports.costStore   = costStore;
module.exports.globalStats = globalStats;
