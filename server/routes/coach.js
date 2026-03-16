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
- Identify the agent from the ability icons at the bottom of the screen. Each agent has a unique set of 4 ability icons.`;

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

// POST /api/coach/analyze  — raw binary JPEG body
router.post('/analyze', async (req, res) => {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();

  if (!licenseKey) return res.status(400).json({ error: 'X-License-Key header required' });
  if (!await validateKey(licenseKey)) return res.status(403).json({ error: 'Invalid or expired license key' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No image data' });

  const t0 = Date.now();
  try {
    const tip = await Promise.race([
      geminiCall(req.body.toString('base64'), SMART_PROMPT, 150),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout')), 10000)),
    ]);
    trackCall(licenseKey);
    console.log('[coach] ' + licenseKey.slice(0, 8) + '... -> "' + (tip || '').slice(0, 60) + '" (' + (Date.now() - t0) + 'ms)');
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

module.exports = router;
module.exports.costStore   = costStore;
module.exports.globalStats = globalStats;
