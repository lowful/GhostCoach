const Anthropic = require('@anthropic-ai/sdk');

// ─── Sanitization ──────────────────────────────────────────────────────────────
// Runs on EVERY AI response before use — strips em/en-dashes and spaced hyphens.
function sanitizeText(text) {
  if (!text) return '';
  return text
    .replace(/\u2014/g, ', ')   // em-dash —
    .replace(/\u2013/g, ', ')   // en-dash –
    .replace(/ - /g, ', ')      // spaced hyphen " - "
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── System Prompts (Valorant only) ────────────────────────────────────────────

const SMART_PROMPT = `You are an Immortal/Radiant level Valorant coach analyzing live gameplay screenshots. Give tips based on what top players and pro teams actually do.

Determine the game state and respond with EXACTLY one of these:
- WAITING: Not a live Valorant match (main menu, lobby, agent select, loading screen, queue, non-Valorant content on screen)
- ROUND_END: Post-round scoreboard, end-of-round results, or buy phase just started after a completed round
- During active gunfights: give at most ONE brief tip (max 8 words) if you see a critical mistake. If the player is mid-combat and a tip was already given this encounter, respond with exactly 'ACTIVE_WAIT'.
- PLAYER_DEAD|<tip>: Player is dead, spectating, or on death recap screen. After the pipe, add ONE specific tip under 12 words about what caused the death or what to do differently.
- A short coaching tip: For buy phase, pre-round spawn, calm positioning, post-plant watching, rotating, or checking minimap

Your Valorant game knowledge:
Map control: Default positions before committing to a site on attack. On defense, play retake on some rounds instead of always holding. Crossfires win rounds.
Economy: Full buy at 3900+ credits. Force buy round 2 after winning pistol. Full save if team is broke, never half-buy. Spectre is best force buy weapon. Always buy light shields on pistol round.
Common mistakes: Peeking one by one instead of trading. Not using utility before peeking. Wide swinging when you should hold the angle. Ego peeking after getting a pick. Not checking minimap. Rotating too early or too late based on limited info.
Positioning: Off-angles beat common angles. Play close angles with shotguns, long angles with Vandal or Operator. Reposition after every kill. Never re-peek the same angle twice in a row.
Agent awareness: Remind about key abilities, Sage wall timings, Sova recon at round start, Omen smokes for site takes.

Tip rules: Under 12 words maximum. No em-dashes, long dashes, or the character. Use commas and periods only. Be specific, use callout names, economy terms, or positioning cues.`;

const BETWEEN_ROUNDS_PROMPT = `You are an Immortal/Radiant Valorant coach. Only give a tip during buy phase (buy menu visible, timer running) or pre-round countdown.
Active live round: give at most ONE brief tip (max 8 words) if you see a critical mistake. If mid-combat and a tip was already given this encounter, respond with exactly 'ACTIVE_WAIT'. Not in a Valorant game = WAITING. End-of-round scoreboard = ROUND_END. Player dead or spectating = PLAYER_DEAD|<tip under 12 words>.
Tip rules: Under 12 words. No em-dashes or long dashes. Use commas and periods. Focus on buy decisions and positioning for the upcoming round.`;

const ROUND_START_DEATH_PROMPT = `You are an Immortal/Radiant Valorant coach. Only give a tip at round start (buy timer visible, first seconds of round) or when the player is dead/spectating.
Active live round: give at most ONE brief tip (max 8 words) if you see a critical mistake. If mid-combat and a tip was already given this encounter, respond with exactly 'ACTIVE_WAIT'. Not in a game = WAITING. Round end scoreboard = ROUND_END.
For death, respond: PLAYER_DEAD|<specific tip about what caused the death or better decision, under 12 words>
Tip rules: Under 12 words. No em-dashes or long dashes. Use commas and periods.`;

const ALWAYS_PROMPT = `You are an Immortal/Radiant Valorant coach. Analyze this screenshot.
Respond: WAITING (no game/menu), ROUND_END (scoreboard), ACTIVE_WAIT (if mid-combat and a tip was already given this encounter), PLAYER_DEAD|<tip> (death screen), or give a coaching tip.
During active gunfights: give at most ONE brief tip (max 8 words) if you see a critical mistake.
Tip rules: Under 12 words. No em-dashes or long dashes. Use commas and periods. Be specific with callouts, economy terms, or positioning.`;

const PROMPT_MAP = {
  smart:             SMART_PROMPT,
  between_rounds:    BETWEEN_ROUNDS_PROMPT,
  round_start_death: ROUND_START_DEATH_PROMPT,
  always:            ALWAYS_PROMPT
};

const ROUND_SUMMARY_PROMPT = `You are analyzing a Valorant round that just ended. Provide a round summary as valid JSON only. No markdown, no code blocks, just raw JSON:
{"round_result":"win","things_done_well":["specific praise under 12 words","specific praise"],"things_to_improve":["specific advice under 12 words","specific advice"],"key_tip_for_next_round":"one focused tip under 12 words","performance_rating":3}
Rules: round_result is "win", "loss", or "unknown". 1-3 items per array. performance_rating 1-5 based on decision quality not kills. No em-dashes, no long dashes, use commas and periods only.`;

// ─── Rate limiting ─────────────────────────────────────────────────────────────
let lastCallTime = 0;
const MIN_CALL_GAP = 5000;
const API_TIMEOUT  = 8000;

let clientInstance = null;
function getClient(apiKey) {
  if (!clientInstance || clientInstance._apiKey !== apiKey) {
    clientInstance = new Anthropic({ apiKey });
    clientInstance._apiKey = apiKey;
  }
  return clientInstance;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`API timeout after ${ms}ms`)), ms)
    )
  ]);
}

// ─── Main analysis ─────────────────────────────────────────────────────────────
// combatTipGiven: true if a tip was already shown in the current combat encounter
async function analyzeScreenshot(base64Image, apiKey, mode = 'smart', combatTipGiven = false, recentTips = []) {
  const now = Date.now();
  const gap = now - lastCallTime;
  if (gap < MIN_CALL_GAP) await new Promise(r => setTimeout(r, MIN_CALL_GAP - gap));
  lastCallTime = Date.now();

  let systemPrompt = PROMPT_MAP[mode] || SMART_PROMPT;

  // If a combat tip was already given this encounter, remind AI not to give another
  if (combatTipGiven) {
    systemPrompt += '\n\nNOTE: A tip was already given for the current combat engagement. If combat is still ongoing, respond with \'ACTIVE_WAIT\'.';
  }

  // Inject recent tip history so the AI builds on prior advice instead of repeating it
  if (recentTips.length > 0) {
    systemPrompt += `\n\nRecent tips already given this match (do NOT repeat these — build on them or find new angles):\n${recentTips.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
  }

  const client = getClient(apiKey);

  const response = await withTimeout(
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          { type: 'text', text: 'Analyze this screenshot.' }
        ]
      }]
    }),
    API_TIMEOUT
  );

  return sanitizeText(response.content[0]?.text?.trim() || '');
}

// ─── Round summary ─────────────────────────────────────────────────────────────
async function getRoundSummary(base64Image, apiKey) {
  const client = getClient(apiKey);

  const response = await withTimeout(
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: ROUND_SUMMARY_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          { type: 'text', text: 'Provide the round summary JSON.' }
        ]
      }]
    }),
    12000
  );

  const text = sanitizeText(response.content[0]?.text?.trim() || '');
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

// ─── Match detection ───────────────────────────────────────────────────────────
async function checkIfMatch(base64Image, apiKey) {
  const client = getClient(apiKey);
  try {
    const response = await withTimeout(
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system: 'You detect if a screenshot shows an active Valorant session. Active = gameplay, buy phase, agent select, loading screen. NOT active = desktop, menus, lobbies, queue, other games, browser. Respond with only MATCH or NOT_MATCH.',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
            { type: 'text', text: 'Is this a match?' }
          ]
        }]
      }),
      API_TIMEOUT
    );
    const ans = response.content[0]?.text?.trim().toUpperCase() || '';
    return ans === 'MATCH' || (ans.includes('MATCH') && !ans.includes('NOT'));
  } catch {
    return false;
  }
}

// ─── Alive check (used while player is dead) ────────────────────────────────────
async function checkIfAlive(base64Image, apiKey) {
  const client = getClient(apiKey);
  try {
    const response = await withTimeout(
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system: 'Is the player alive and in an active round or buy phase? Or are they dead, spectating, or on death screen? Respond with only YES (alive) or NO (dead/spectating).',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
            { type: 'text', text: 'Is the player alive?' }
          ]
        }]
      }),
      API_TIMEOUT
    );
    const ans = response.content[0]?.text?.trim().toUpperCase() || '';
    return ans === 'YES' || ans.startsWith('YES');
  } catch {
    return true; // assume alive on timeout, don't block coaching
  }
}

// ─── Match summary ─────────────────────────────────────────────────────────────
async function getMatchSummary(tipTexts, apiKey) {
  const client = getClient(apiKey);
  const tipsContext = tipTexts.slice(0, 30).join('. ');

  const system = `You are summarizing a Valorant coaching session. Tips given during this match: ${tipsContext}

Based on patterns in these tips, create a match performance summary as valid JSON only. No markdown, no code blocks:
{"match_result":"unknown","overall_rating":5,"strengths":["string","string","string"],"weaknesses":["string","string","string"],"most_common_mistake":"string","biggest_improvement_tip":"string","highlight_moments":["string","string"]}

Rules: overall_rating 1-10. match_result is "victory", "defeat", or "unknown". No em-dashes, long dashes, or the character. Use commas and periods only. All items under 15 words.`;

  try {
    const response = await withTimeout(
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: 'Generate match summary JSON.' }]
      }),
      12000
    );
    const text = sanitizeText(response.content[0]?.text?.trim() || '');
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

module.exports = {
  analyzeScreenshot,
  getRoundSummary,
  checkIfMatch,
  checkIfAlive,
  getMatchSummary,
  sanitizeText
};
