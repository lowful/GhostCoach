'use strict';

const { captureScreen }     = require('./capture');
const { analyzeScreenshot, getRoundRecap } = require('./api');

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
    "If you have Operator money, make sure your team can also full buy."
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
    "You peeked while your teammate was already fighting. Wait for the trade moment."
  ]
};

// ─── Keyword detection ────────────────────────────────────────────────────────
const ECONOMY_KW = /\b(buy|save|credit|eco|force|shield|vandal|phantom|spectre|marshal|operator|ghost|stinger|sheriff|ares|rifle|pistol)\b/i;
const DEATH_KW   = /\b(died|death|peeked without|crosshair was|should have|next time|mistake|spectating)\b/i;

// ─── CoachingEngine ───────────────────────────────────────────────────────────
class CoachingEngine {
  constructor() {
    this.licenseKey          = '';
    this.isCapturing         = false;
    this.matchTips           = [];   // AI-only tips for match review
    this.shownLibraryTips    = new Set();
    this.captureInterval     = null;

    // Round tracking for recap + economy tips
    this.wasInBuyPhase       = false;
    this.currentRoundTips    = [];
    this.shownEconomyTip     = false; // one per round start

    // Callbacks — set by index.js before calling start()
    this.onTip      = null;   // ({ text, isLibrary, timestamp }) => void
    this.onStatus   = null;   // (statusKey: string) => void
    this.onMatchEnd = null;   // (tips: string[]) => void
    this.onRecap    = null;   // (text: string) => void
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────
  start(licenseKey) {
    this.licenseKey       = licenseKey;
    this.matchTips        = [];
    this.shownLibraryTips = new Set();
    this.isCapturing      = false;
    this.wasInBuyPhase    = false;
    this.currentRoundTips = [];
    this.shownEconomyTip  = false;

    // AI capture every 15s
    this.captureInterval = setInterval(() => {
      this.captureAndAnalyze();
    }, 15000);

    // First AI tip after 5s warmup
    setTimeout(() => this.captureAndAnalyze(), 5000);

    console.log('[engine] Started — AI 15s interval, no library timer');
  }

  stop() {
    if (this.captureInterval) { clearInterval(this.captureInterval); this.captureInterval = null; }
    this.isCapturing = false;
    console.log('[engine] Stopped');
  }

  // ─── Manual / forced capture (Ctrl+Shift+T / Ctrl+Shift+S) ─────────────────
  requestImmediateCapture() {
    this.captureAndAnalyze(true);
  }

  // ─── Library tips (event-driven only) ────────────────────────────────────────
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

  // ─── AI capture + analyze ────────────────────────────────────────────────────
  async captureAndAnalyze(forced = false) {
    if (this.isCapturing && !forced) return;
    this.isCapturing = true;

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
    if (this.onStatus) this.onStatus('coaching');
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
    if (!/[.!?]$/.test(t)) return;  // incomplete sentence

    // Clean dashes
    const clean = t
      .replace(/[\u2014\u2013\u2012\u2015]/g, ',')
      .replace(/ - /g, ', ')
      .slice(0, 120);

    const isBuyPhase = ECONOMY_KW.test(clean);
    const isDeath    = DEATH_KW.test(clean);

    // Round transition: gameplay → buy phase
    if (isBuyPhase && !this.wasInBuyPhase) {
      // New round started — trigger recap if enough tips from last round
      if (this.currentRoundTips.length >= 2) {
        const roundTips = [...this.currentRoundTips];
        this.currentRoundTips = [];
        getRoundRecap(roundTips, this.licenseKey).then(recap => {
          if (recap && this.onRecap) this.onRecap(recap);
        }).catch(() => {});
      } else {
        this.currentRoundTips = [];
      }

      // Show one economy library tip at round start
      if (!this.shownEconomyTip) {
        this.shownEconomyTip = true;
        this.showLibraryTip('economy');
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

    // Death detected → show a death library tip 4s later
    if (isDeath) {
      setTimeout(() => this.showLibraryTip('death'), 4000);
    }
  }
}

module.exports = CoachingEngine;
