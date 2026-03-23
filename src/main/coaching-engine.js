'use strict';

const Store = require('electron-store');
const store = new Store();

class CoachingEngine {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || '';
    this.licenseKey = options.licenseKey || '';
    this.captureFunction = options.captureFunction || null;
    this.onTip = null;
    this.onStatusChange = null;
    this.onMatchReview = null;

    // State
    this.isRunning = false;
    this.isCapturing = false;
    this.tips = [];
    this.roundTips = [];
    this.matchTips = [];
    this.shownLibraryTips = new Set();
    this.lastScreenshotTime = 0;
    this.lastTipTime = 0;
    this.consecutiveDeaths = 0;
    this.roundNumber = 0;
    this.inBurstMode = false;
    this.burstTimer = null;

    // Timers
    this.mainTimer = null;
    this.libraryTimer = null;

    // Player info
    this.playerUsername = store.get('valorantUsername', '');
    this.playerStats = null;
  }

  // ============ TIP LIBRARIES ============

  get library() {
    return {
      roundStart: [
        "Check what your team is buying. Match their economy.",
        "Pick a different angle than last round. Be unpredictable.",
        "Think about the enemy economy. Are they saving or buying?",
        "Make sure you have full shields before the barrier drops.",
        "Use the buy phase to plan your utility usage for the round.",
        "If attacking, decide which site to hit before the round starts.",
        "If defending, set up crossfires with a teammate.",
        "Buy abilities first, then weapons. Utility wins rounds.",
        "Think about where you died last round. Play a different spot.",
        "If the enemy keeps rushing, consider stacking that site."
      ],
      economy: [
        "Pistol round: buy light shields and abilities only. No rifles.",
        "After winning pistol, buy Spectre and full shields.",
        "After losing pistol, full save. Buy nothing.",
        "Under 2000 credits means full save. Do not buy anything.",
        "Force buy round: Spectre with light shields is best value.",
        "Full buy at 3900 or more. Vandal or Phantom with full shields.",
        "If your team is saving, save with them. Never buy alone.",
        "Always buy full shields when you can afford them."
      ],
      death: [
        "You peeked without utility. Flash or smoke before peeking next time.",
        "Your crosshair was too low. Always aim at head height.",
        "You took a solo duel. Play with a teammate for trades.",
        "You repeeked the same angle. Always reposition after shooting.",
        "You wide swung that corner. Jiggle peek for info first.",
        "Check minimap before pushing. Know where your team is.",
        "You ran into the open without clearing corners. Slow down.",
        "They heard your footsteps. Walk when close to enemies.",
        "You used your ability too late. Use it before peeking.",
        "You pushed through a smoke. Never walk through enemy smokes."
      ],
      combat: [
        "Trade your teammate. If they die, swing immediately.",
        "Do not repeek. Reposition after every engagement.",
        "Use utility before swinging. Flash or smoke the angle.",
        "Stay calm. Aim for the head, do not panic spray.",
        "If your teammate is fighting, be ready to refrag.",
        "Do not chase kills. Hold your position after getting one.",
        "If they are pushing, fall back to a better angle.",
        "In a 1vX, play time and isolate duels one by one.",
        "Listen for audio cues before peeking any angle."
      ],
      spike: [
        "Spike is down. Play time on attack, do not repeek.",
        "On retake, group up. Do not go one by one.",
        "Check all corners before defusing. Clear the site.",
        "Smoke the spike for a safe defuse attempt.",
        "Half defuse to bait them out, then fight.",
        "Do not rotate until you hear spike at a site."
      ],
      motivation: [
        "Shake off last round. Reset and focus on this one.",
        "One round at a time. Stay in the moment.",
        "Stay confident. Trust your aim and your game sense.",
        "Every death is a lesson. Apply it next round.",
        "Losing rounds happens. The comeback starts now.",
        "Take a breath. Calm shots beat panic sprays.",
        "Stay positive in comms. Good vibes win rounds.",
        "You do not need to top frag. Play your role.",
        "One clutch round can shift the entire game.",
        "Mute toxic players. Protect your mental."
      ],
      hype: [
        "Good round. Keep this energy going.",
        "You are reading them well. Trust your instincts.",
        "Momentum is yours. Stay disciplined.",
        "Economy is strong. Dominate this round.",
        "Keep playing together. This is winnable."
      ]
    };
  }

  // ============ CORE METHODS ============

  start() {
    this.isRunning = true;
    this.tips = [];
    this.roundTips = [];
    this.matchTips = [];
    this.roundNumber = 1;
    this.updateStatus('coaching');

    // Fetch player stats if username is set
    if (this.playerUsername) {
      this.fetchPlayerStats();
    }

    // Start round burst immediately (first round)
    this.startRoundBurst();

    // Main screenshot timer — every 18 seconds
    this.mainTimer = setInterval(() => {
      if (!this.inBurstMode) {
        this.captureAndAnalyze();
      }
    }, 18000);

    console.log('[engine] Coaching started');
  }

  stop() {
    this.isRunning = false;
    clearInterval(this.mainTimer);
    clearInterval(this.libraryTimer);
    clearTimeout(this.burstTimer);
    this.mainTimer = null;
    this.libraryTimer = null;
    this.burstTimer = null;
    this.inBurstMode = false;
    this.updateStatus('stopped');

    // Trigger match review if we had tips
    if (this.matchTips.length >= 3) {
      this.requestMatchReview();
    }

    console.log('[engine] Coaching stopped');
  }

  // ============ ROUND BURST ============

  startRoundBurst() {
    this.inBurstMode = true;
    console.log('[engine] Round burst started (round', this.roundNumber, ')');

    // Immediate: economy tip
    this.showLibraryTip('economy');

    // At 3 seconds: AI screenshot (analyze buy phase)
    setTimeout(() => {
      if (this.isRunning) this.captureAndAnalyze();
    }, 3000);

    // At 7 seconds: round start tip
    setTimeout(() => {
      if (this.isRunning) this.showLibraryTip('roundStart');
    }, 7000);

    // At 14 seconds: second AI screenshot (pre-round positioning)
    setTimeout(() => {
      if (this.isRunning) this.captureAndAnalyze();
    }, 14000);

    // At 20 seconds: end burst mode, return to normal pacing
    this.burstTimer = setTimeout(() => {
      this.inBurstMode = false;
      console.log('[engine] Round burst ended');
    }, 20000);
  }

  // ============ LIBRARY TIPS ============

  showLibraryTip(category) {
    const tips = this.library[category];
    if (!tips || tips.length === 0) return;

    const key = category + ':';
    const available = tips.filter(t => !this.shownLibraryTips.has(key + t));
    if (available.length === 0) {
      // Reset shown tips for this category
      tips.forEach(t => this.shownLibraryTips.delete(key + t));
      return this.showLibraryTip(category);
    }

    const tip = available[Math.floor(Math.random() * available.length)];
    this.shownLibraryTips.add(key + tip);
    this.emitTip(tip, 'library', category);
  }

  // ============ AI SCREENSHOTS ============

  async captureAndAnalyze() {
    if (this.isCapturing || !this.isRunning) return;
    if (Date.now() - this.lastScreenshotTime < 8000) return; // Min 8s gap

    this.isCapturing = true;
    this.lastScreenshotTime = Date.now();

    try {
      if (!this.captureFunction) {
        this.isCapturing = false;
        return;
      }

      const screenshot = await this.captureFunction();
      if (!screenshot) {
        this.isCapturing = false;
        return;
      }

      const response = await fetch(this.serverUrl + '/api/coach/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'X-License-Key': this.licenseKey,
          'X-Player-Stats': this.playerStats ? JSON.stringify(this.playerStats) : ''
        },
        body: Buffer.from(screenshot, 'base64'),
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        this.isCapturing = false;
        return;
      }

      const data = await response.json();
      if (data.tip) {
        this.handleAIResponse(data.tip);
      }
    } catch (e) {
      console.error('[engine] Capture error:', e.message);
    }

    this.isCapturing = false;
  }

  handleAIResponse(text) {
    const trimmed = text.trim();

    // Filter bad responses
    if (trimmed.toUpperCase() === 'SKIP') return;
    if (trimmed.length < 15) return;
    if (!trimmed.match(/[.!?"]$/)) return; // Must end with punctuation

    // Detect round transition (buy phase mentioned after gameplay)
    if (trimmed.toLowerCase().match(/buy|credits|save|pistol round|economy|full buy/)) {
      if (this.roundTips.length > 0) {
        // New round detected
        this.roundNumber++;
        this.roundTips = [];
        this.startRoundBurst();
        return; // Burst mode will handle tips
      }
    }

    // Detect death
    if (trimmed.toLowerCase().match(/you died|you are dead|spectating|death screen/)) {
      this.consecutiveDeaths++;
      this.showLibraryTip('death');
      if (this.consecutiveDeaths >= 2) {
        setTimeout(() => this.showLibraryTip('motivation'), 5000);
      }
      return;
    }

    // Normal tip — reset death counter
    this.consecutiveDeaths = 0;

    // Display the AI tip
    const cleaned = trimmed.replace(/—/g, ',').replace(/–/g, ',').replace(/ - /g, ', ');
    this.emitTip(cleaned, 'ai', 'general');
    this.roundTips.push(cleaned);
    this.matchTips.push(cleaned);
  }

  // ============ PLAYER STATS FROM TRACKER ============

  async fetchPlayerStats() {
    try {
      const response = await fetch(
        this.serverUrl + '/api/coach/player-stats?username=' + encodeURIComponent(this.playerUsername),
        {
          headers: { 'X-License-Key': this.licenseKey },
          signal: AbortSignal.timeout(10000)
        }
      );
      if (response.ok) {
        this.playerStats = await response.json();
        console.log('[engine] Player stats loaded:', this.playerStats.rank);
      }
    } catch (e) {
      console.log('[engine] Could not fetch player stats:', e.message);
    }
  }

  // ============ MATCH REVIEW ============

  async requestMatchReview() {
    try {
      const response = await fetch(this.serverUrl + '/api/coach/match-review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-License-Key': this.licenseKey
        },
        body: JSON.stringify({ tips: this.matchTips }),
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) {
        const data = await response.json();
        if (this.onMatchReview) this.onMatchReview(data.review);
      }
    } catch (e) {
      console.log('[engine] Match review error:', e.message);
    }
  }

  // ============ TIP EMISSION ============

  emitTip(text, source, category) {
    const tip = { text, source, category, time: Date.now() };
    this.tips.push(tip);
    if (this.tips.length > 50) this.tips.shift();
    this.lastTipTime = Date.now();
    console.log('[engine] Tip:', source, '-', text);
    if (this.onTip) this.onTip(tip);
  }

  updateStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
  }

  // ============ MANUAL TIP REQUEST ============

  async requestTip() {
    await this.captureAndAnalyze();
  }
}

module.exports = CoachingEngine;
