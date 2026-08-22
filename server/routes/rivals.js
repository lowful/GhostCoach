'use strict';

/**
 * Marvel Rivals coaching.
 *
 * Separate from coach.js on purpose. The Valorant prompt and its guards each
 * exist because of a specific reproduced failure, and this file must never be a
 * reason to edit them. What IS shared is the provider layer, which coach.js
 * already exports for exactly this: the reasoning-token guard, the credits
 * breaker and the licence check are each the scar of a real outage, and
 * duplicating them would mean re-learning every one.
 *
 * The cadence is the whole difference. Valorant coaching reads a frame every ten
 * seconds, roughly 360 an hour. Rivals reads hero select once and the scoreboard
 * once, two to five captures a match, because the decisions that actually settle
 * a hero shooter are discrete: what you pick, and when you switch.
 *
 * WHAT THE CAPTURE FRAMES SETTLED, which the written plan had wrong: the enemy
 * team is NOT on screen at hero select. There is a hero picker, your own team's
 * slots, the map and a timer, and no enemy roster anywhere. So a draft tip can
 * never speak about the enemy comp, and counter picking belongs to the switch
 * call instead, where the scoreboard finally shows who you are playing.
 *
 * What the game does print is SUGGESTED PICK: <ROLE>, bottom right. That is the
 * Rivals equivalent of Valorant printing a location name on the HUD: a fact the
 * model reads rather than infers, and therefore the thing that outranks it.
 */
const express = require('express');
const router = express.Router();

// The provider layer, exported by coach.js rather than extracted, because its
// members sit interleaved with Valorant prompt code. See the note at the bottom
// of that file.
const { visionInfer, sanitize, validateKey, creditsLookExhausted, creditsRetryIn } = require('./coach').ai;

// NOTHING is required from src/ here, and check:server-boot enforces it. Only
// server/ is deployed, so a require reaching outside it resolves in development
// and throws on Railway. coach.js requires nothing from src/ for the same
// reason, and the split it implies is the right one anyway: the server reads
// the screen, the CLIENT decides what is fit to show. Every Valorant guard
// lives in coaching-engine.js, not in coach.js, and the Rivals guards live in
// rivals-engine.js for exactly the same reason.

// ─── The prompt ──────────────────────────────────────────────────────────────
// Two lines out, the same contract the Valorant coach uses, because the client
// already knows how to parse it and a second format is a second thing to break.
const STATE_CONTRACT = `
Reply in EXACTLY two lines and nothing else.

Line 1: the tip, ONE sentence, at most 22 words, addressed to the player as "you".
Line 2: STATE: {...} as compact JSON.

If the screen is not Marvel Rivals hero select or a scoreboard, reply with the
single word SKIP and nothing else. If it is a menu, lobby or loading screen,
reply with the single word LOBBY and nothing else. Never explain either word.`;

const DRAFT_PROMPT = `You are coaching a Marvel Rivals player during hero select.

READ ONLY WHAT IS ON THE SCREEN. Never infer, never assume, never fill a gap
with what is usually true.

The screen has:
- the game MODE and its objective, top left, for example "CONVERGENCE" and
  "Escort Knull's Essence to the Underground". This is the mode, NOT the map.
  The map name is not printed on this screen, so leave map out.
- the hero picker on the right, filtered by a role tab. These are heroes
  AVAILABLE to pick. They are NOT your team and NOT the enemy team. Ignore them
  completely when counting your team.
- a countdown in the centre
- the game's own recommendation, bottom right, printed as "SUGGESTED PICK: <ROLE>"

YOUR TEAM IS THE ROW OF SLOTS ALONG THE VERY BOTTOM EDGE of the screen, below
the countdown. This row is the single most important thing to read and it is
easy to miss, so look at it deliberately.

There are six slots in that bottom row, left to right. Each slot is either:
- FILLED: it shows a hero portrait, with a small white role icon beside it.
  Count this teammate and report their role.
- EMPTY: it shows a plain placeholder with no portrait, often a "?" shape.
  Do not count it.

Count the FILLED slots one by one, left to right, and put one role in "locked"
for each. Do not include yourself. If you genuinely cannot tell a slot's role,
put "unknown" for it rather than leaving it out, because a short list is read as
a nearly empty team and produces the opposite advice.

Sanity check before you answer: the countdown runs down from about thirty
seconds and players lock in as it falls, so late in the draft MOST slots are
filled. If the countdown is under ten seconds and you counted no teammates at
all, you have misread the bottom row. Look again.

THE ENEMY TEAM IS NOT ON THIS SCREEN. You cannot see what they picked. Never say
anything about the enemy team, their comp, or what they are running. If you
catch yourself about to, coach your own team's composition instead.

Roles are Vanguard (front line), Duelist (damage) and Strategist (healing). A
standard team is two of each.

The tip must name a ROLE to pick and say what is missing without it. Do not name
a specific hero unless you can read its name on screen.

STATE fields, omit any you cannot read rather than guessing:
  phase      always "draft"
  mode       the mode name printed top left, for example "CONVERGENCE"
  suggested  the role from the SUGGESTED PICK banner, exactly as printed
  locked     one entry per FILLED slot in the bottom row, excluding you, using
             "Vanguard", "Duelist", "Strategist" or "unknown"
  filled     how many of the six bottom slots have a hero portrait, as a number
  timer      seconds left on the countdown, as a number
${STATE_CONTRACT}`;

const REVIEW_PROMPT = `You are reviewing a finished Marvel Rivals match from its scoreboard.

READ ONLY WHAT IS ON THE SCREEN.

The scoreboard shows both teams, six players each, GROUPED BY ROLE in a fixed
order: Vanguard, then Duelist, then Strategist. Each row has a role icon, a hero
portrait, the player name, kills / deaths / assists, medals, Final Hits, Damage,
Damage Blocked, Healing and Accuracy. The player being coached is the row
highlighted in a different colour. MVP and SVP are marked at the left.

Healing concentrates in the Strategist rows and Damage Blocked in the Vanguard
rows, so use those columns to check the role grouping you read. If they disagree
with the icons, say nothing about roles rather than guessing.

The tip must be one specific, checkable thing the player can do next match,
drawn from their own row. Never invent a number that is not printed.

STATE fields, omit any you cannot read:
  phase    always "scoreboard"
  result   "victory" or "defeat"
  map, mode
  me       {name, role, kills, deaths, assists, damage, blocked, healing, accuracy}
  mvp      the name marked MVP, if visible
${STATE_CONTRACT}`;

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Split the two-line reply.
 *
 * If this ever silently stops finding STATE the coach keeps talking while going
 * blind, which is the exact failure mode the Valorant contract carries a warning
 * about, so a missing STATE is reported rather than defaulted.
 */
function splitReply(raw) {
  const text = String(raw || '').trim();
  if (!text) return { tip: '', state: null, protocol: null };
  if (/^(SKIP|LOBBY)$/i.test(text)) return { tip: '', state: null, protocol: text.toUpperCase() };

  const i = text.search(/STATE\s*:/i);
  if (i < 0) return { tip: sanitize(text), state: null, protocol: null };
  const tip = sanitize(text.slice(0, i).trim());
  let state = null;
  try {
    const json = text.slice(i).replace(/^[^{]*/, '');
    state = JSON.parse(json.slice(0, json.lastIndexOf('}') + 1));
  } catch { state = null; }
  return { tip, state, protocol: null };
}

/**
 * Roles the model reported for locked teammates, RAW.
 *
 * Deliberately not normalised-and-filtered here, which is how this was written
 * first and was wrong in a way that quietly disarmed every guard downstream.
 * countRoles refuses to judge a roster containing anything it cannot read, and
 * dropping the unreadable entries first means it never sees one: a roster of
 * "Vanguard, Sorcerer, Duelist" arrives as a clean two-role roster, the trust
 * check passes, and the coach gives confident advice about a team it only
 * partly read. The raw strings go through so that check can do its job.
 */
function lockedRoles(state) {
  const raw = state && Array.isArray(state.locked) ? state.locked : [];
  return raw.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
}

// ─── Routes ──────────────────────────────────────────────────────────────────

async function guard(req, res) {
  const licenseKey = String(req.headers['x-license-key'] || '').trim().toUpperCase();
  if (!licenseKey) { res.status(400).json({ error: 'X-License-Key header required' }); return null; }
  if (!await validateKey(licenseKey)) { res.status(403).json({ error: 'Invalid or expired license key' }); return null; }
  const image = req.body && req.body.image;
  if (!image || typeof image !== 'string') { res.status(400).json({ error: 'No image data' }); return null; }
  return image;
}

/** Report a credits outage honestly rather than pretending to be down. */
function creditsReply(res, err) {
  const retry = creditsRetryIn ? creditsRetryIn() : 180;
  return res.status(402).json({ error: 'credits', retryIn: retry, message: String(err && err.message || '') });
}

// POST /api/rivals/draft   { image } -> { tip, context, blocked? }
router.post('/draft', async (req, res) => {
  const image = await guard(req, res);
  if (!image) return;
  try {
    if (creditsLookExhausted && creditsLookExhausted()) return creditsReply(res, new Error('breaker open'));
    const raw = await visionInfer(image, DRAFT_PROMPT, 320, false);
    const { tip, state, protocol } = splitReply(raw);
    if (protocol) return res.json({ tip: protocol, context: {} });

    const ctx = state || {};
    // The roster goes back RAW, unreadable entries and all, because the guard
    // that decides whether to trust it runs on the client and needs to see them.
    ctx.locked = lockedRoles(ctx);
    return res.json({ tip, context: ctx });
  } catch (err) {
    if (creditsLookExhausted && creditsLookExhausted(err)) return creditsReply(res, err);
    console.error('[rivals] draft failed:', err.message);
    return res.status(500).json({ error: 'Draft read failed' });
  }
});

// POST /api/rivals/review   { image } -> { tip, context }
router.post('/review', async (req, res) => {
  const image = await guard(req, res);
  if (!image) return;
  try {
    if (creditsLookExhausted && creditsLookExhausted()) return creditsReply(res, new Error('breaker open'));
    const raw = await visionInfer(image, REVIEW_PROMPT, 380, false);
    const { tip, state, protocol } = splitReply(raw);
    if (protocol) return res.json({ tip: protocol, context: {} });
    return res.json({ tip, context: state || {} });
  } catch (err) {
    if (creditsLookExhausted && creditsLookExhausted(err)) return creditsReply(res, err);
    console.error('[rivals] review failed:', err.message);
    return res.status(500).json({ error: 'Review failed' });
  }
});

module.exports = router;
module.exports.__test = { splitReply, lockedRoles, DRAFT_PROMPT, REVIEW_PROMPT };
