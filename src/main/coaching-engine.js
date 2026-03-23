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
    // Context tracking
    this.roundEstimate = 1;
    this.roundsSinceLastBuy = 0;
    this.consecutiveDeaths = 0;
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.lastPhase = 'unknown';
    this.shownFromCategory = {};
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.tipHistory = [];
    this.tipIndex = 0;
    this.lastTipTime = 0;
    this.skipCount = 0;
    this.roundEstimate = 1;
    this.roundsSinceLastBuy = 0;
    this.consecutiveDeaths = 0;
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.lastPhase = 'unknown';
    this.shownFromCategory = {};
    this.emit('status', 'coaching');
    console.log('[engine] Started');

    // Welcome tips
    this.showContextualLibraryTip();
    setTimeout(() => {
      if (this.isRunning) this.showContextualLibraryTip();
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

  showContextualLibraryTip() {
    if (Date.now() - this.lastTipTime < 20000) return;

    let category = 'positioning'; // default fallback

    if (this.consecutiveDeaths >= 2) {
      category = 'motivation';
      this.consecutiveDeaths = 0;
    } else if (this.consecutiveWins >= 2) {
      category = 'hype';
      this.consecutiveWins = 0;
    } else if (this.lastPhase === 'death') {
      category = 'death';
    } else if (this.lastPhase === 'buy') {
      if (this.roundEstimate <= 3 || (this.roundEstimate >= 13 && this.roundEstimate <= 15)) {
        category = 'early';
      } else {
        category = 'economy';
      }
    } else if (this.lastPhase === 'postplant') {
      category = 'spike';
    } else {
      const rotatingCategories = ['positioning', 'combat', 'utility', 'strategy'];
      const idx = Math.floor(Date.now() / 30000) % rotatingCategories.length;
      category = rotatingCategories[idx];
    }

    const tips = TIP_CATEGORIES[category];
    if (!tips || tips.length === 0) return;

    if (!this.shownFromCategory[category]) this.shownFromCategory[category] = new Set();
    const shown = this.shownFromCategory[category];
    const available = tips.filter(t => !shown.has(t));

    if (available.length === 0) {
      shown.clear();
      return;
    }

    const tip = available[Math.floor(Math.random() * available.length)];
    shown.add(tip);
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

    // Always update context even from SKIP responses
    this.updateContext(trimmed);

    // Check if we should show motivation (2+ deaths in a row) — takes priority
    if (this.consecutiveDeaths >= 2 && Date.now() - this.lastTipTime > 20000) {
      console.log('[engine] Showing motivation tip, deaths:', this.consecutiveDeaths);
      this.showContextualLibraryTip();
      return;
    }

    // Check if we should show hype (2+ wins in a row) — takes priority
    if (this.consecutiveWins >= 2 && Date.now() - this.lastTipTime > 20000) {
      console.log('[engine] Showing hype tip, wins:', this.consecutiveWins);
      this.showContextualLibraryTip();
      return;
    }

    // Filter non-tips
    if (trimmed.toUpperCase() === 'SKIP' || trimmed.length < 15) {
      this.skipCount++;
      console.log('[engine] SKIP, count:', this.skipCount);
      if (this.skipCount >= 3) {
        this.skipCount = 0;
        this.showContextualLibraryTip();
      }
      return;
    }

    // Enforce 20-second cooldown between tips
    if (Date.now() - this.lastTipTime < 20000) {
      console.log('[engine] Tip skipped due to cooldown');
      return;
    }

    this.skipCount = 0;
    const cleaned = trimmed.replace(/—/g, ',').replace(/–/g, ',').replace(/ - /g, ', ');
    this.emitTip(cleaned, 'ai');
  }

  updateContext(text) {
    const lower = text.toLowerCase();

    if (lower.match(/buy phase|credits|economy|buy |save this|full buy|force buy|pistol/)) {
      if (this.lastPhase !== 'buy') {
        this.roundEstimate++;
        console.log('[engine] New round detected, estimate:', this.roundEstimate);
      }
      this.lastPhase = 'buy';
    } else if (lower.match(/you died|dead|spectating|death/)) {
      this.lastPhase = 'death';
      this.consecutiveDeaths++;
      this.consecutiveWins = 0;
    } else if (lower.match(/spike planted|defuse|post.plant|retake/)) {
      this.lastPhase = 'postplant';
    } else if (lower.match(/won|nice round|good round/)) {
      this.consecutiveWins++;
      this.consecutiveDeaths = 0;
      this.lastPhase = 'active';
    } else if (lower.match(/lost|losing|loss/)) {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
      this.lastPhase = 'active';
    } else if (lower !== 'skip') {
      this.lastPhase = 'active';
      if (this.consecutiveDeaths > 0) {
        this.consecutiveDeaths = 0;
      }
    }

    if (lower.includes('pistol round') || lower.includes('round 1')) {
      this.roundEstimate = 1;
    } else if (lower.includes('second half') || lower.includes('round 13')) {
      this.roundEstimate = 13;
    }

    console.log('[engine] Context: phase=' + this.lastPhase + ' round=' + this.roundEstimate + ' deaths=' + this.consecutiveDeaths + ' wins=' + this.consecutiveWins);
  }

  async requestTip() {
    console.log('[engine] Manual tip requested');
    if (!this.isRunning || this.isCapturing) return;
    this.isCapturing = true;

    try {
      const screenshot = await this.captureFunction();
      if (!screenshot) { this.isCapturing = false; return; }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(this.serverUrl + '/api/coach/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-License-Key': this.licenseKey,
          'X-Forced': 'true'
        },
        body: Buffer.from(screenshot, 'base64'),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        const tip = (data.tip || '').trim();
        if (tip.length > 10) {
          const cleaned = tip.replace(/—/g, ',').replace(/–/g, ',').replace(/ - /g, ', ');
          // Bypass cooldown for manual requests
          const tipObj = { text: cleaned, source: 'ai', time: Date.now() };
          this.tipHistory.push(tipObj);
          if (this.tipHistory.length > 50) this.tipHistory.shift();
          this.lastTipTime = Date.now();
          console.log('[engine] FORCED TIP:', cleaned);
          this.emit('tip', tipObj);
        }
      }
    } catch (e) {
      console.log('[engine] Force tip error:', e.message);
    }

    this.isCapturing = false;
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

const TIP_CATEGORIES = {
  early: [
    "Pistol round: buy light shields and abilities only. No rifles possible.",
    "After winning pistol, buy Spectre and full shields next round.",
    "After losing pistol, full save. Do not buy anything at all.",
    "Second round after losing pistol, your team should full save together.",
    "If you won pistol, your team has a big economy advantage. Press it."
  ],
  economy: [
    "Full buy when you have 3900 or more. Vandal or Phantom with full shields.",
    "If your team is saving, save with them. Never buy alone.",
    "Always buy full shields when you can afford them. 50 HP is huge.",
    "Buy abilities every round. Utility wins more rounds than guns.",
    "Force buy round: Spectre with light shields is the best value.",
    "If you cannot afford a rifle, the Marshal is a strong budget option.",
    "Do not buy Operator unless your whole team can also full buy."
  ],
  positioning: [
    "Hold off-angles instead of common spots. Catch them off guard.",
    "After getting a kill, reposition immediately. Do not repeek.",
    "Play with a teammate to set up crossfires. Never hold alone.",
    "On defense, do not peek. Let them come to you and hold the angle.",
    "If your flank is open, fall back to a safer position.",
    "Do not stand in the open. Always have cover nearby to retreat to.",
    "When rotating, go through spawn. Mid rotation alone is risky.",
    "Play retake sometimes instead of always holding on site.",
    "Stack a site on defense if you keep reading the same enemy pattern."
  ],
  combat: [
    "Always aim at head height, even when just walking around the map.",
    "Do not wide swing corners. Jiggle peek for information first.",
    "Trade your teammate. If they die, peek and shoot immediately.",
    "Do not reload after every kill. Finish the fight first.",
    "Counter-strafe before shooting. Moving makes your shots inaccurate.",
    "Use your flash or smoke before peeking any dangerous angle.",
    "If you hear footsteps, stop moving and hold an angle.",
    "Do not crouch spray at long range. Tap fire for accuracy."
  ],
  utility: [
    "Use utility before dry peeking. Flash, smoke, or drone first.",
    "Save your abilities for key moments. Do not waste them early.",
    "Smoke choke points before your team pushes through them.",
    "Flash for your teammates when they entry. Support their push.",
    "Drone or recon before pushing onto a site blind.",
    "Molly or nade default plant spots to deny spike plants."
  ],
  spike: [
    "After planting spike, play time. Do not repeek or push them.",
    "On retake, group up with your team. Do not go in one by one.",
    "Check all corners before defusing. Clear the site first.",
    "Smoke the spike and defuse. Have teammates watch angles.",
    "Do not rotate until you hear spike commit to a specific site.",
    "If spike is planted for you, hold your angle and wait patiently.",
    "Half defuse to bait them out, then fight."
  ],
  death: [
    "You peeked without utility. Flash or smoke next time before peeking.",
    "Your crosshair was probably too low. Always aim at head height.",
    "Trading is key. Play close to a teammate so they can refrag.",
    "Do not repeek the same angle twice. Always reposition after a fight.",
    "Walking when close to enemies prevents them from hearing you.",
    "Never push through an enemy smoke. You are blind, they are not.",
    "Think about what info you had before that peek. Did you drone or flash?",
    "If you died holding a common angle, try an off-angle next round."
  ],
  strategy: [
    "Default on attack. Spread out, get info, then hit a site together.",
    "If the enemy keeps rushing, consider stacking that site.",
    "Think about the enemy economy. Are they saving or full buying?",
    "Pick a different angle than last round. Be unpredictable.",
    "Communicate enemy positions to your team when you spot them.",
    "On anti-eco rounds, do not push. Let them come to you.",
    "If the enemy has an Operator, smoke it off. Do not challenge with rifles.",
    "Pre-aim common angles as you walk around corners."
  ],
  motivation: [
    "Shake off that last round. Reset your mental and focus on the next one.",
    "One round at a time. Stay in the moment.",
    "Stay confident. Trust your aim and your game sense.",
    "Every death is a lesson. Apply it next round.",
    "Losing rounds happens. The comeback starts now.",
    "Take a breath. Calm shots beat panic sprays every time.",
    "Stay positive in comms. Good vibes help your team win.",
    "You do not need to top frag to win. Play your role well.",
    "Mute toxic players if you need to. Protect your mental game.",
    "Do not tilt. The more frustrated you get, the worse you play."
  ],
  hype: [
    "Good round. Keep this energy going into the next one.",
    "You are reading them well. Trust your instincts this round.",
    "Momentum is on your side. Stay disciplined and keep it up.",
    "Economy is strong. Dominate this round with a full buy.",
    "Keep playing together as a team. This game is yours to win.",
    "You are in the zone. Stay focused and keep making smart plays.",
    "That was a clean round. More of that and this is an easy win."
  ]
};

module.exports = CoachingEngine;
