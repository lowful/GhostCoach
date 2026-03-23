const EventEmitter = require('events');

class CoachingEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.serverUrl = options.serverUrl || '';
    this.licenseKey = options.licenseKey || '';
    this.captureFunction = options.captureFunction || null;
    this.isRunning = false;
    this.isCapturing = false;
    this.tipHistory = [];
    this.timer = null;
    this.tipIndex = 0;
    this.lastTipTime = 0;
    this.skipCount = 0;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.tipHistory = [];
    this.tipIndex = 0;
    this.lastTipTime = 0;
    this.skipCount = 0;
    this.emit('status', 'coaching');
    console.log('[engine] Started');

    // Welcome tips
    this.showNextLibraryTip();
    setTimeout(() => {
      if (this.isRunning) this.showNextLibraryTip();
    }, 8000);

    // AI screenshot every 30 seconds — the ONLY recurring timer
    this.timer = setInterval(() => {
      if (this.isRunning && !this.isCapturing) {
        this.captureAndAnalyze();
      }
    }, 30000);

    // First AI screenshot after 15 seconds
    setTimeout(() => {
      if (this.isRunning && !this.isCapturing) {
        this.captureAndAnalyze();
      }
    }, 15000);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('status', 'stopped');
    console.log('[engine] Stopped');
  }

  showNextLibraryTip() {
    if (Date.now() - this.lastTipTime < 20000) {
      console.log('[engine] Library tip skipped due to cooldown');
      return;
    }
    const tip = ALL_TIPS[this.tipIndex % ALL_TIPS.length];
    this.tipIndex++;
    this.emitTip(tip, 'library');
  }

  async captureAndAnalyze() {
    if (this.isCapturing || !this.isRunning || !this.captureFunction) return;
    this.isCapturing = true;
    console.log('[engine] Taking screenshot for AI analysis');

    try {
      const screenshot = await this.captureFunction();
      if (!screenshot) { this.isCapturing = false; return; }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(this.serverUrl + '/api/coach/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-License-Key': this.licenseKey
        },
        body: Buffer.from(screenshot, 'base64'),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        this.handleAIResponse(data.tip || '');
      }
    } catch (e) {
      console.log('[engine] AI error:', e.message);
    }

    this.isCapturing = false;
  }

  handleAIResponse(text) {
    const trimmed = text.trim();

    // Filter non-tips
    if (trimmed.toUpperCase() === 'SKIP' || trimmed.length < 15) {
      this.skipCount++;
      console.log('[engine] SKIP received, count:', this.skipCount);

      // After 3 skips (90 seconds of nothing), show a library tip to keep app alive
      if (this.skipCount >= 3) {
        this.skipCount = 0;
        if (Date.now() - this.lastTipTime > 20000) {
          this.showNextLibraryTip();
        }
      }
      return;
    }

    // Enforce 20-second cooldown between tips
    if (Date.now() - this.lastTipTime < 20000) {
      console.log('[engine] Tip skipped due to cooldown');
      return;
    }

    // Reset skip counter since we got a real tip
    this.skipCount = 0;

    const cleaned = trimmed.replace(/—/g, ',').replace(/–/g, ',').replace(/ - /g, ', ');
    this.emitTip(cleaned, 'ai');
  }

  async requestTip() {
    await this.captureAndAnalyze();
  }

  emitTip(text, source) {
    const tip = { text, source, time: Date.now() };
    this.tipHistory.push(tip);
    if (this.tipHistory.length > 50) this.tipHistory.shift();
    this.lastTipTime = Date.now();
    console.log('[engine] TIP (' + source + '):', text);
    this.emit('tip', tip);
  }
}

// All tips in one flat array, ordered for a natural coaching flow
const ALL_TIPS = [
  // Economy
  "Pistol round: buy light shields and abilities only. No rifles possible.",
  "After winning pistol, buy Spectre and full shields next round.",
  "After losing pistol, full save. Do not buy anything at all.",
  "Force buy round: Spectre with light shields is the best value.",
  "Full buy when you have 3900 or more. Vandal or Phantom with full shields.",
  "If your team is saving, save with them. Never buy alone.",
  "Always buy full shields when you can afford them. 50 HP is huge.",
  "Buy abilities every round. Utility wins more rounds than guns.",

  // Positioning
  "Hold off-angles instead of common spots. Catch them off guard.",
  "After getting a kill, reposition immediately. Do not repeek.",
  "Play with a teammate to set up crossfires. Never hold alone.",
  "On defense, do not peek. Let them come to you and hold the angle.",
  "Check your minimap every few seconds for enemy positions.",
  "If your flank is open, fall back to a safer position.",
  "Do not stand in the open. Always have cover nearby to retreat to.",
  "When rotating, go through spawn. Mid rotation alone is risky.",

  // Combat
  "Always aim at head height, even when just walking around the map.",
  "Do not wide swing corners. Jiggle peek for information first.",
  "Trade your teammate. If they die, peek and shoot immediately.",
  "Do not reload after every kill. Finish the fight first.",
  "Counter-strafe before shooting. Moving makes your shots inaccurate.",
  "Do not crouch spray at long range. Tap fire for accuracy.",
  "Use your flash or smoke before peeking any dangerous angle.",
  "If you hear footsteps, stop moving and hold an angle.",

  // Utility
  "Use utility before dry peeking. Flash, smoke, or drone first.",
  "Save your abilities for key moments. Do not waste them early.",
  "Smoke choke points before your team pushes through them.",
  "Molly or nade default plant spots to deny spike plants.",
  "Flash for your teammates when they entry. Support their push.",
  "Drone or recon before pushing onto a site blind.",

  // Spike situations
  "After planting spike, play time. Do not repeek or push them.",
  "On retake, group up with your team. Do not go in one by one.",
  "Check all corners before defusing. Clear the site first.",
  "Smoke the spike and defuse. Have teammates watch angles.",
  "Do not rotate until you hear spike commit to a specific site.",
  "If spike is planted for you, hold your angle and wait patiently.",

  // Mental and strategy
  "Shake off a bad round. Reset your mental and focus on the next one.",
  "Stay positive in comms. Good vibes help your team play better.",
  "If you keep dying at the same spot, switch positions next round.",
  "Think about the enemy economy. Are they saving or full buying?",
  "Pick a different angle than last round. Be unpredictable.",
  "Communicate enemy positions to your team when you spot them.",
  "If you are last alive, play for information and time.",
  "One clutch round can shift the entire game momentum. Stay focused.",
  "Do not tilt. Mute toxic teammates and focus on your own gameplay.",
  "Every death is a lesson. Think about what to do differently next time.",

  // Death specific
  "You peeked without utility. Flash or smoke next time before peeking.",
  "Your crosshair was probably too low. Always aim at head height.",
  "Trading is key. Play close to a teammate so they can refrag.",
  "Do not repeek the same angle twice. Always reposition after a fight.",
  "Walking when close to enemies prevents them from hearing you.",
  "Never push through an enemy smoke. You are blind, they are not.",

  // Advanced
  "Default on attack. Spread out, get info, then hit a site together.",
  "Stack a site on defense if you keep reading the same enemy pattern.",
  "Play retake sometimes instead of always holding on site.",
  "Pre-aim common angles as you walk around corners.",
  "On anti-eco rounds, do not push. Let them come to you with pistols.",
  "If the enemy has an Operator, smoke it off. Do not challenge it with rifles."
];

module.exports = CoachingEngine;
