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

async function geminiCall(imageB64, prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/jpeg', data: imageB64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: maxTokens || 100, temperature: 0.3 },
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
      return sanitize(text);
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
          generationConfig: { maxOutputTokens: maxTokens || 600, temperature: 0.3 },
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
    res.json({ tip: '' });
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

module.exports = router;
module.exports.costStore   = costStore;
module.exports.globalStats = globalStats;
