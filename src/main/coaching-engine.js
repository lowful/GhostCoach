'use strict';

const { captureScreen }     = require('./capture');
const { analyzeScreenshot, getRoundRecap } = require('./api');
const store = require('./store');

// ─── Built-in tip library ─────────────────────────────────────────────────────
const TIPS = {
  economy: [
    "Pistol round: buy light shields and abilities. No rifles.",
    "After winning pistol, buy Spectre and full shields round two.",
    "After losing pistol, full save round two. Buy nothing.",
    "Under 2000 credits, full save. Do not buy anything.",
    "Force buy round: Spectre with light shields is best value.",
    "Full buy at 3900 credits or more. Vandal or Phantom with full shields.",
    "If your team is saving, save with them. Never buy alone.",
    "Marshal is great on a budget if you cannot afford a rifle.",
    "Always buy full shields when you can afford them. Fifty HP matters.",
    "If you have Operator money, make sure your team can also full buy.",
  ],
  death: [
    "You peeked without using any utility. Flash or smoke before peeking next time.",
    "Your crosshair placement was too low. Always aim at head height.",
    "You took a solo duel. Play with a teammate for trades next time.",
    "You repeeked the same angle twice. Always reposition after a fight.",
    "You wide swung that corner. Jiggle peek for info before committing.",
    "Check your minimap before pushing. A teammate might already have that angle.",
    "You ran into the open without clearing corners. Slow down and clear.",
    "You crouched during the fight. Stay standing for better movement options.",
    "They heard your footsteps. Walk when you are close to enemies.",
    "You used your ability too late. Use it before you peek, not after.",
    "You challenged a long-range fight with a short-range gun. Smoke it off instead.",
    "You pushed through a smoke. Never walk through enemy smokes.",
    "You were looking at the ground when they peeked. Keep crosshair up.",
    "You stood still while shooting. Counter-strafe between shots.",
    "You peeked while your teammate was already fighting. Wait for the trade moment.",
  ],
  roundStart: [
    "New round. Play slow for the first 10 seconds and gather info before committing.",
    "Comm your default position now. Information is the most valuable resource.",
    "This round: prioritize crosshair placement over movement speed.",
    "Use utility for information before pushing. Do not play blind.",
    "Watch your flank. Entry fraggers get flanked most often at round start.",
    "Play a default and stay patient. Force them to make the first mistake.",
    "Check the minimap every few seconds. Your team's spread tells you everything.",
    "Do not burn utility in the first ten seconds. Save it for the plant or defense.",
  ],
  motivation: [
    "Three deaths in a row? That is tilt. This round: play passive and take only safe trades.",
    "You are getting frustrated. Recognize it. Slow down, breathe, reset crosshair placement.",
    "Even pros hit death streaks. One clean round turns it around. Play smart, not fast.",
    "Stop rushing them. This round: let them come to you. Play reactively.",
    "Frustration makes you peek without info. This round: gather info before every commitment.",
    "Breathe. Tilt is real. Play ultra-conservative this round and reset your mental.",
    "Down? Focus on one thing: crosshair placement. That alone will get you the kill.",
  ],
  hype: [
    "Halftime. Clean slate. Come back with one goal: play your game.",
    "Second half, different side, different reads. Adapt right now.",
    "Clutch time. One player, slow play, let them make the mistake.",
    "Stay calm. In clutches, the player who panics first loses.",
    "You have got this. Trust your fundamentals. Clean crosshair placement wins rounds.",
    "Last few rounds. Everything you have learned this session — apply it right now.",
    "Halftime reset. Energy and focus both start fresh. Make this half yours.",
  ],
};

// ─── Keyword detection ────────────────────────────────────────────────────────
const ECONOMY_KW = /\b(buy|save|credit|eco|force|shield|vandal|phantom|spectre|marshal|operator|ghost|stinger|sheriff|ares|rifle|pistol)\b/i;
const DEATH_KW   = /\b(died|death|peeked without|crosshair was|should have|next time|mistake|spectating)\b/i;
const CLUTCH_KW  = /\b(clutch|alone|last player|1v[2-5]|outnumbered)\b/i;

// ─── CoachingEngine ───────────────────────────────────────────────────────────
class CoachingEngine {
  constructor() {
    this.licenseKey          = '';
    this.isCapturing         = false;
    this.stopped             = false;
    this.matchTips           = [];
    this.shownLibraryTips    = new Set();
    this.captureInterval     = null;
    this._timers             = [];

    // Round tracking
    this.wasInBuyPhase       = false;
    this.currentRoundTips    = [];
    this.shownEconomyTip     = false;
    this.roundNumber         = 0;
    this.isBurstActive       = false;

    // Audio state (FEATURE 2)
    this.audioState          = 'quiet';
    this.combatEndTime       = null;
    this.lastCaptureTime     = null;

    // Motivational tracking (FEATURE 5)
    this.consecutiveDeaths          = 0;
    this.motivationalGivenThisRound = false;
    this.halfTimeGiven              = false;

    // Callbacks — set by index.js before calling start()
    this.onTip      = null;   // (tipData) => void
    this.onStatus   = null;   // (statusKey) => void
    this.onMatchEnd = null;   // (tips) => void
    this.onRecap    = null;   // (text) => void
  }

  // ─── Timer helper (auto-cancelled on stop) ───────────────────────────────────
  _setTimeout(fn, ms) {
    const t = setTimeout(() => {
      this._timers = this._timers.filter(x => x !== t);
      if (!this.stopped) fn();
    }, ms);
    this._timers.push(t);
    return t;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────
  start(licenseKey) {
    this.licenseKey             = licenseKey;
    this.matchTips              = [];
    this.shownLibraryTips       = new Set();
    this.isCapturing            = false;
    this.stopped                = false;
    this.wasInBuyPhase          = false;
    this.currentRoundTips       = [];
    this.shownEconomyTip        = false;
    this.roundNumber            = 0;
    this.isBurstActive          = false;
    this.audioState             = 'quiet';
    this.combatEndTime          = null;
    this.lastCaptureTime        = null;
    this.consecutiveDeaths      = 0;
    this.motivationalGivenThisRound = false;
    this.halfTimeGiven          = false;

    const interval = CoachingEngine.modeInterval(store.get('performanceMode') || 'balanced');
    this.captureInterval = setInterval(() => this.captureAndAnalyze(), interval);
    setTimeout(() => this.captureAndAnalyze(), 5000);

    console.log('[engine] Started');
  }

  stop() {
    this.stopped = true;
    this._timers.forEach(t => clearTimeout(t));
    this._timers = [];
    if (this.captureInterval) { clearInterval(this.captureInterval); this.captureInterval = null; }
    this.isCapturing = false;
    console.log('[engine] Stopped');
  }

  // ─── Live performance mode update ────────────────────────────────────────────
  setPerformanceMode(mode) {
    if (!this.captureInterval) return;
    clearInterval(this.captureInterval);
    const interval = CoachingEngine.modeInterval(mode);
    this.captureInterval = setInterval(() => this.captureAndAnalyze(), interval);
    console.log(`[engine] Performance mode → ${mode} (${interval / 1000}s)`);
  }

  static modeInterval(mode) {
    if (mode === 'quality')     return 10000;
    if (mode === 'lightweight') return 25000;
    return 15000;
  }

  // ─── Manual capture (Ctrl+Shift+T / Ctrl+Shift+S) ────────────────────────────
  requestImmediateCapture() {
    this.captureAndAnalyze(true);
  }

  // ─── Audio state (FEATURE 2) ─────────────────────────────────────────────────
  setAudioState(state) {
    if (state !== 'combat' && this.audioState === 'combat') {
      this.combatEndTime = Date.now();
    }
    this.audioState = state;
  }

  // ─── Library tips ────────────────────────────────────────────────────────────
  showLibraryTip(category) {
    const pool      = TIPS[category] || TIPS.death;
    let   available = pool.filter(t => !this.shownLibraryTips.has(t));
    if (available.length === 0) {
      pool.forEach(t => this.shownLibraryTips.delete(t));
      available = [...pool];
    }
    const tip = available[Math.floor(Math.random() * available.length)];
    this.shownLibraryTips.add(tip);
    if (this.onTip) this.onTip({ text: tip, isLibrary: true, timestamp: Date.now() });
  }

  // ─── Motivational tips (FEATURE 5) ───────────────────────────────────────────
  showMotivationalTip(category) {
    const pool = TIPS[category] || TIPS.motivation;
    const tip  = pool[Math.floor(Math.random() * pool.length)];
    if (this.onTip) this.onTip({ text: tip, isLibrary: true, isMotivational: true, timestamp: Date.now() });
  }

  // ─── AI capture + analyze ────────────────────────────────────────────────────
  async captureAndAnalyze(forced = false, burstCapture = false) {
    if (this.isCapturing && !forced && !burstCapture) return;
    this.isCapturing = true;

    const now = Date.now();

    if (!forced && !burstCapture) {
      // Block regular interval during burst (burst controls its own timing)
      if (this.isBurstActive) { this.isCapturing = false; return; }
      // Audio gate: skip during combat unless 30s fallback exceeded
      if (this.audioState === 'combat') {
        if (!this.lastCaptureTime || now - this.lastCaptureTime < 30000) {
          this.isCapturing = false; return;
        }
      }
      // Post-combat 3s delay
      if (this.combatEndTime && now - this.combatEndTime < 3000) {
        this.isCapturing = false; return;
      }
    }

    this.lastCaptureTime = now;

    try {
      if (this.onStatus) this.onStatus('capturing');
      const { buffer, hash } = await captureScreen();
      if (this.onStatus) this.onStatus('analyzing');
      const result = await analyzeScreenshot(buffer, this.licenseKey, 'smart', false, [], hash, forced);
      this.handleAIResponse(result || '', forced);
    } catch (err) {
      console.error('[engine] Error:', err.message);
      if (this.onStatus) {
        if (err.message.includes('timeout') || err.message.includes('ENOTFOUND') || err.message.includes('ETIMEDOUT')) {
          this.onStatus('connection_lost');
        }
      }
    }

    this.isCapturing = false;
    if (!this.stopped && this.onStatus) this.onStatus('coaching');
  }

  // ─── Response processing ─────────────────────────────────────────────────────
  handleAIResponse(text, forced = false) {
    const t = text.trim();
    if (!t || t.length < 20) return;

    const upper = t.toUpperCase();
    if (upper === 'SKIP') return;
    if (upper === 'VICTORY' || upper === 'DEFEAT') {
      if (this.onMatchEnd) this.onMatchEnd([...this.matchTips]);
      return;
    }
    if (!/[.!?]$/.test(t)) return;

    const clean = t
      .replace(/[\u2014\u2013\u2012\u2015]/g, ',')
      .replace(/ - /g, ', ')
      .slice(0, 120);

    const isBuyPhase = ECONOMY_KW.test(clean);
    const isDeath    = DEATH_KW.test(clean);
    const isClutch   = CLUTCH_KW.test(clean);

    // Round transition: gameplay → buy phase = new round
    if (isBuyPhase && !this.wasInBuyPhase) {
      this.roundNumber++;

      // Recap for the round just ended
      if (this.currentRoundTips.length >= 2) {
        const roundTips = [...this.currentRoundTips];
        this.currentRoundTips = [];
        getRoundRecap(roundTips, this.licenseKey).then(recap => {
          if (recap && this.onRecap) this.onRecap(recap);
        }).catch(() => {});
      } else {
        this.currentRoundTips = [];
      }

      // Reset per-round motivational state
      this.motivationalGivenThisRound = false;
      this.consecutiveDeaths          = 0;

      // Round start burst (FEATURE 3)
      if (!this.shownEconomyTip) {
        this.shownEconomyTip = true;
        this.isBurstActive   = true;

        this.showLibraryTip('economy');                                          // 0s
        this._setTimeout(() => this.captureAndAnalyze(false, true), 3000);      // 3s AI
        this._setTimeout(() => this.showLibraryTip('roundStart'),   8000);      // 8s lib
        this._setTimeout(() => this.captureAndAnalyze(false, true), 15000);     // 15s AI
        this._setTimeout(() => { this.isBurstActive = false; },     20000);     // 20s end
      }

      // Halftime hype at round 12 (FEATURE 5)
      if (this.roundNumber === 12 && !this.halfTimeGiven) {
        this.halfTimeGiven = true;
        this._setTimeout(() => this.showMotivationalTip('hype'), 4000);
      }
    }

    if (!isBuyPhase) {
      this.wasInBuyPhase   = false;
      this.shownEconomyTip = false;
    } else {
      this.wasInBuyPhase = true;
    }

    // Track for match review + round recap
    this.matchTips.push(clean);
    if (!isBuyPhase) this.currentRoundTips.push(clean);

    // Show AI tip
    if (this.onTip) this.onTip({ text: clean, isLibrary: false, timestamp: Date.now() });

    // Death handling (FEATURE 5)
    if (isDeath) {
      this.consecutiveDeaths++;
      this._setTimeout(() => this.showLibraryTip('death'), 4000);

      if (this.consecutiveDeaths >= 3 && !this.isBurstActive && !this.motivationalGivenThisRound) {
        this.motivationalGivenThisRound = true;
        this._setTimeout(() => this.showMotivationalTip('motivation'), 6000);
      }
    } else if (!isBuyPhase) {
      this.consecutiveDeaths = 0; // good play resets streak
    }

    // Clutch detected → hype (FEATURE 5)
    if (isClutch && !this.isBurstActive && !this.motivationalGivenThisRound) {
      this.motivationalGivenThisRound = true;
      this._setTimeout(() => this.showMotivationalTip('hype'), 2000);
    }
  }
}

module.exports = CoachingEngine;
