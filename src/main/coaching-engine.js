'use strict';
const EventEmitter = require('events');

class CoachingEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.serverUrl       = options.serverUrl || '';
    this.licenseKey      = options.licenseKey || '';
    this.captureFunction = options.captureFunction || null;

    this.matchContext = {
      agent:             null,
      map:               null,
      side:              null,
      roundNumber:       0,
      teamScore:         0,
      enemyScore:        0,
      phase:             'unknown', // buy | active | postplant | dead | menu
      playerCredits:     null,
      playerWeapon:      null,
      playerAlive:       true,
      lastDeathReason:   null,
      lastTipsGiven:     [],
      consecutiveDeaths: 0,
      consecutiveWins:   0,
      roundsPlayed:      0,
    };

    this.isRunning       = false;
    this.isCapturing     = false;
    this.shouldAbort     = false;
    this.lastCaptureTime = 0;
    this.lastTipTime     = 0;
    this.skipCount       = 0;
    this.captureTimer    = null;
    this.tipHistory      = [];
  }

  start() {
    console.log('[engine] start() called, isRunning was:', this.isRunning);
    if (this.isRunning) return;
    this.isRunning   = true;
    this.shouldAbort = false;
    this.lastTipTime = 0; // 0 = no prior tip, so first AI tip is not blocked by cooldown
    this.matchContext.agent = null; // re-detect agent each session
    console.log('[engine] License key set:', this.licenseKey ? 'YES (' + this.licenseKey.substring(0, 8) + '...)' : 'NO');
    console.log('[engine] Server URL:', this.serverUrl);
    console.log('[engine] Capture function set:', this.captureFunction ? 'YES' : 'NO');
    this.emit('status', 'coaching');
    console.log('[engine] Started');

    setTimeout(() => {
      if (!this.isRunning) return;
      this.emit('tip', {
        text:   this.getWelcomeMessage(),
        source: 'system',
        time:   Date.now(),
      });
    }, 2000);

    setTimeout(() => {
      if (this.isRunning) this.captureAndAnalyze();
    }, 12000);

    this.captureTimer = setInterval(() => {
      if (this.isRunning && !this.isCapturing) this.captureAndAnalyze();
    }, 15000);
  }

  stop() {
    this.isRunning   = false;
    this.shouldAbort = true;
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    this.emit('status', 'stopped');

    const aiTipCount = this.tipHistory.filter(t => t.source === 'ai').length;
    if (aiTipCount >= 3) this.requestMatchReview();
    console.log('[engine] Stopped');
  }

  async captureAndAnalyze() {
    console.log('[engine] captureAndAnalyze() called');
    if (this.isCapturing) { console.log('[engine] Skipping: already capturing'); return; }
    const sinceLast = Date.now() - this.lastCaptureTime;
    if (sinceLast < 10000) { console.log('[engine] Skipping: only', sinceLast, 'ms since last capture'); return; }

    this.isCapturing     = true;
    this.lastCaptureTime = Date.now();

    try {
      console.log('[engine] About to call captureFunction');
      const screenshot = await this.captureFunction();
      console.log('[engine] Capture returned:', screenshot ? 'data (' + screenshot.length + ' chars)' : 'null');
      if (this.shouldAbort) { console.log('[engine] Aborted after capture'); this.isCapturing = false; return; }
      if (!screenshot)      { console.log('[engine] No screenshot data, aborting'); this.isCapturing = false; return; }

      console.log('[engine] Sending to server:', this.serverUrl + '/api/coach/analyze');
      const response = await this.sendToServer(screenshot);
      console.log('[engine] Server response:', response ? JSON.stringify(response).slice(0, 200) : 'null');
      if (this.shouldAbort) { console.log('[engine] Aborted after server response'); this.isCapturing = false; return; }
      if (response) this.processAIResponse(response);
    } catch (e) {
      console.error('[engine] Capture error:', e.message, e.stack && e.stack.split('\n')[1]);
    }

    this.isCapturing = false;
  }

  async sendToServer(screenshot, forced) {
    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 8000);

      const headers = {
        'Content-Type':  'application/json',
        'X-License-Key': this.licenseKey,
      };
      if (forced) headers['X-Forced'] = 'true';

      console.log('[engine] fetch() starting, body size ~', screenshot.length, 'chars');
      const response = await fetch(this.serverUrl + '/api/coach/analyze', {
        method:  'POST',
        headers,
        body:    JSON.stringify({ image: screenshot, context: this.matchContext }),
        signal:  controller.signal,
      });

      clearTimeout(timeout);
      console.log('[engine] Server response status:', response.status);
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.error('[engine] Non-OK response body:', errText.slice(0, 200));
        return null;
      }
      const data = await response.json();
      return data;
    } catch (e) {
      console.error('[engine] Server error:', e.message);
      return null;
    }
  }

  processAIResponse(response) {
    console.log('[engine] RAW response from server:', JSON.stringify(response).slice(0, 300));
    console.log('[engine] response.tip type:', typeof response.tip, 'value:', String(response.tip).slice(0, 100));

    if (response.context) this.updateMatchContext(response.context);

    const tip = response.tip;
    if (!tip) return;
    let trimmed = String(tip).trim();

    // Guard: never display raw JSON as a tip
    if (trimmed.startsWith('{') || trimmed.startsWith('"tip"') || trimmed.includes('"tip":')) {
      console.error('[engine] Rejecting JSON-looking tip:', trimmed.slice(0, 100));
      return;
    }

    // Strip stray surrounding quotes
    trimmed = trimmed.replace(/^["']/, '').replace(/["']$/, '').trim();

    if (trimmed.toUpperCase() === 'SKIP' || trimmed.length < 20) {
      this.skipCount++;
      console.log('[engine] SKIP, count:', this.skipCount);
      if (this.skipCount >= 2) {
        this.skipCount = 0;
        this.showContextualLibraryTip();
      }
      return;
    }

    // Aggressive truncation detection — reject tips ending mid-thought
    const truncationPatterns = [
      /\band\.?$/i,  /\bor\.?$/i,   /\bbut\.?$/i,
      /\bto\.?$/i,   /\bwith\.?$/i, /\bfor\.?$/i,
      /\bthe\.?$/i,  /\ba\.?$/i,    /\ban\.?$/i,
      /\bof\.?$/i,   /\bin\.?$/i,   /\bat\.?$/i,
      /\bon\.?$/i,   /\byour\.?$/i, /\bmy\.?$/i,
      /'s\.?$/i,     /,\s*$/,
    ];
    for (const pattern of truncationPatterns) {
      if (pattern.test(trimmed)) {
        console.error('[engine] Rejecting truncated tip:', trimmed);
        return;
      }
    }

    if (!trimmed.match(/[.!?"]$/)) {
      console.log('[engine] Rejected incomplete tip:', trimmed);
      return;
    }

    // Hard length cap — even if AI ignored the 14-word instruction
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount > 16) {
      console.log('[engine] Rejecting tip too long:', wordCount, 'words:', trimmed);
      return;
    }

    if (Date.now() - this.lastTipTime < 18000) {
      console.log('[engine] Tip skipped due to cooldown');
      return;
    }

    this.skipCount = 0;
    const cleaned  = trimmed.replace(/—/g, ',').replace(/–/g, ',').replace(/ - /g, ', ');
    this.emitTip(cleaned, 'ai');

    this.matchContext.lastTipsGiven.push(cleaned);
    if (this.matchContext.lastTipsGiven.length > 3) this.matchContext.lastTipsGiven.shift();
  }

  updateMatchContext(updates) {
    const prevPhase  = this.matchContext.phase;
    const prevRound  = this.matchContext.roundNumber;

    Object.keys(updates).forEach(key => {
      const v = updates[key];
      if (v === null || v === undefined) return;

      // Agent is LOCKED once set. Cannot change mid-session.
      if (key === 'agent') {
        if (this.matchContext.agent && this.matchContext.agent !== v) {
          console.log('[engine] BLOCKED agent change:', this.matchContext.agent, '->', v);
          return;
        }
        if (!this.matchContext.agent) {
          console.log('[engine] Agent locked to:', v);
          this.matchContext.agent = v;
          return;
        }
        return; // agent already matches, nothing to do
      }

      // Map is also locked once set
      if (key === 'map') {
        if (this.matchContext.map && this.matchContext.map !== v) {
          console.log('[engine] BLOCKED map change:', this.matchContext.map, '->', v);
          return;
        }
      }

      this.matchContext[key] = v;
    });

    // Round transition: structured signal from AI, not text matching
    if (typeof updates.roundNumber === 'number' && updates.roundNumber > prevRound) {
      this.matchContext.roundsPlayed++;
      console.log('[engine] Round transition:', prevRound, '->', updates.roundNumber);
    }

    // Death streak tracking via phase transitions
    if (updates.phase === 'dead' && prevPhase !== 'dead') {
      this.matchContext.consecutiveDeaths++;
      this.matchContext.consecutiveWins = 0;
    }
    if (updates.phase === 'active' && prevPhase === 'dead') {
      this.matchContext.consecutiveDeaths = 0;
    }

    console.log('[engine] Context: agent=' + (this.matchContext.agent || '?') +
      ' round=' + this.matchContext.roundNumber +
      ' phase=' + this.matchContext.phase +
      ' deaths=' + this.matchContext.consecutiveDeaths);
  }

  async showContextualLibraryTip() {
    if (Date.now() - this.lastTipTime < 18000) return;

    const ctx = this.matchContext;
    let category = 'general';
    let priority = 0;

    if (ctx.consecutiveDeaths >= 2)        { category = 'motivation'; priority = 5; }
    else if (ctx.consecutiveWins >= 2)     { category = 'hype';       priority = 5; }
    else if (ctx.phase === 'dead')         { category = 'death';      priority = 4; }
    else if (ctx.phase === 'postplant')    { category = 'spike';      priority = 3; }
    else if (ctx.phase === 'buy') {
      category = (ctx.roundNumber === 1 || ctx.roundNumber === 13) ? 'pistol' : 'economy';
      priority = 3;
    }

    // Low-priority tips need a longer silence before they fire
    if (priority < 3 && Date.now() - this.lastTipTime < 30000) return;

    const tips = TIP_LIBRARY[category] || TIP_LIBRARY.general;
    if (!tips || tips.length === 0) return;

    const recentTexts = this.tipHistory.slice(-10).map(t => t.text);
    const fresh = tips.filter(t => !recentTexts.includes(t));
    const pool  = fresh.length > 0 ? fresh : tips;

    // Ask the AI to pick the best tip from the contextual pool
    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(this.serverUrl + '/api/coach/suggest-library-tip', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-License-Key': this.licenseKey },
        body:    JSON.stringify({ context: ctx, availableTips: pool }),
        signal:  controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        const data = await response.json();
        if (data.tip && pool.includes(data.tip)) {
          this.emitTip(data.tip, 'library');
          return;
        }
      }
    } catch (e) {
      console.error('[engine] AI library-tip selection failed:', e.message);
    }

    // Fallback: random pick from the pool
    const tip = pool[Math.floor(Math.random() * pool.length)];
    this.emitTip(tip, 'library');
  }

  emitTip(text, source) {
    const tip = { text, source, time: Date.now() };
    this.tipHistory.push(tip);
    if (this.tipHistory.length > 50) this.tipHistory.shift();
    this.lastTipTime = Date.now();
    console.log('[engine] TIP (' + source + '):', text);
    this.emit('tip', tip);
  }

  getWelcomeMessage() {
    return WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
  }

  async requestMatchReview() {
    try {
      const aiTips = this.tipHistory.filter(t => t.source === 'ai').map(t => t.text);
      const response = await fetch(this.serverUrl + '/api/coach/match-review', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'X-License-Key': this.licenseKey,
        },
        body: JSON.stringify({ tips: aiTips, context: this.matchContext }),
      });
      if (response.ok) {
        const data = await response.json();
        this.emit('match-review', data.review);
      }
    } catch (e) {
      console.error('[engine] Review error:', e.message);
    }
  }

  async requestTip() {
    if (!this.isRunning || this.isCapturing) return;
    console.log('[engine] Manual tip requested');
    this.isCapturing = true;

    try {
      const screenshot = await this.captureFunction();
      if (this.shouldAbort) { this.isCapturing = false; return; }
      if (!screenshot)      { this.isCapturing = false; return; }

      const response = await this.sendToServer(screenshot, true);
      if (this.shouldAbort) { this.isCapturing = false; return; }
      if (!response) { this.isCapturing = false; return; }

      if (response.context) this.updateMatchContext(response.context);

      const tip = (response.tip || '').trim();
      if (tip.length > 10 && tip.toUpperCase() !== 'SKIP') {
        const cleaned = tip.replace(/—/g, ',').replace(/–/g, ',').replace(/ - /g, ', ');
        this.emitTip(cleaned, 'ai');
        this.matchContext.lastTipsGiven.push(cleaned);
        if (this.matchContext.lastTipsGiven.length > 3) this.matchContext.lastTipsGiven.shift();
      }
    } catch (e) {
      console.error('[engine] Force tip error:', e.message);
    }

    this.isCapturing = false;
  }
}

const WELCOME_MESSAGES = [
  "GhostCoach is locked in. Play smart, I have got you.",
  "Coaching active. Trust your instincts and stay focused.",
  "I am watching every round. Let's climb.",
  "Ready to coach. Stay calm, play your game.",
  "GhostCoach online. Time to dominate.",
];

const TIP_LIBRARY = {
  pistol: [
    "Pistol round: light shields plus abilities only. Save credits for round 2.",
    "On pistol, stick with your team. Win the 5v5 with pure aim and utility.",
    "Pistol round agents: use abilities aggressively, you cannot save them for later.",
  ],
  economy: [
    "Match your team's economy. Never buy alone if they are saving.",
    "Force buy with Spectre and light shields if you have 2000 to 3900 credits.",
    "Full buy at 3900 plus. Vandal or Phantom with full shields and abilities.",
    "Save round means save fully. Even buying a Sheriff hurts your next buy.",
  ],
  general: [
    "Hold off-angles instead of common spots. They will not expect it.",
    "After a kill, reposition immediately. Never repeek the same spot.",
    "Trade your teammate. If they die, swing right after them.",
    "Check your minimap every few seconds. Know where everyone is.",
    "Use utility before peeking. Flash, smoke, or drone first.",
  ],
  death: [
    "Reflect on that death. What info did you have before peeking?",
    "If you peeked without utility, use a flash or drone next time.",
    "Trade was probably possible. Stay closer to your team.",
    "Crosshair placement matters. Always aim at head height as you move.",
  ],
  spike: [
    "Spike is down. Play time on attack, do not push them.",
    "On retake, group up. Going one by one loses every time.",
    "Smoke the spike for a safer defuse attempt.",
    "Half defuse to bait them out, then fight the peek.",
  ],
  motivation: [
    "Reset your mental. The next round is a new opportunity.",
    "Take a breath. Calm aim beats panic spray every time.",
    "Every death is a lesson. Apply it next round.",
    "Stay positive. Tilt makes you play worse.",
  ],
  hype: [
    "You are on a roll. Keep this energy going.",
    "Reading them well. Trust your instincts this round.",
    "Momentum is yours. Stay disciplined and finish them off.",
  ],
};

module.exports = CoachingEngine;
