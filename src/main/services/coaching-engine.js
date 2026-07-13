'use strict';

const EventEmitter = require('events');
const api = require('./api-client');
const tipLibrary = require('./tip-library');
const agentData = require('./agent-data');
const { API, TIMING, PERFORMANCE_INTERVALS, TIP_PACING, COACHING } = require('../../shared/config');

/**
 * The coaching loop. Lives in the main process; the heavy screen capture runs in
 * a Worker Thread (injected as captureFunction) so the game never stalls.
 *
 * Emits:
 *   'tip'          { text, source: 'ai'|'library'|'system', time }
 *   'status'       'coaching' | 'paused' | 'stopped'
 *   'match-review' review string
 */
class CoachingEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.licenseKey      = opts.licenseKey || '';
    this.captureFunction = opts.captureFunction || null;
    this.analyzeInterval = PERFORMANCE_INTERVALS[opts.performanceMode] || PERFORMANCE_INTERVALS.balanced;
    // Tip pacing follows the tier: faster tiers allow more (equally gated) tips.
    this.pacing = TIP_PACING[opts.performanceMode] || TIP_PACING.balanced;
    // Tips the player rated as bad: never re-served from the library, and the
    // most recent ones are sent to the AI so it avoids similar advice.
    this.badTips = new Set(Array.isArray(opts.badTips) ? opts.badTips : []);
    this.playerStats = null;   // tracker profile (rank/KD/HS%), set async after start
    // Experimental settings, read live from the store so a settings flip
    // applies to the very next capture: { proPlaybook: 'off'|'on'|'hybrid' }.
    this.experiments = typeof opts.experiments === 'function' ? opts.experiments : () => ({});

    this.matchContext = freshContext();

    this.isRunning   = false;
    this.isCapturing = false;
    this.paused      = false;
    this.shouldAbort = false;
    this.lastCaptureTime = 0;
    this.lastTipTime     = 0;
    this.skipCount       = 0;
    this.tipHistory      = [];   // { text, source, time }

    this.lastServerStatus = null; // last HTTP status (0 = network/unreachable)
    this.warnedFailure    = false; // one-time server "why no AI tips" notice
    this.failStreak       = 0;     // consecutive analyze failures (1 is a hiccup, 2+ is real)
    this.warnedCapture    = false; // one-time capture-failure notice
    this.lastAuthSuspect  = 0;     // throttle for 401/403 -> license re-check

    this.aiTipCount      = 0;     // coaching-tip mix tracking (AI must stay majority)
    this.libraryTipCount = 0;

    this.enemyHistory  = [];      // recent enemy spots/angles the AI reported
    this.lastWarnedSpot = null;   // de-dupe the "they keep peeking X" warning
    this.recentAbilities = [];    // recent ability words in AI tips (anti-fixation)
    this.lastPhaseChange = null;  // { from, to, at }: round-transition awareness
    this.inLobby        = false;  // server saw a menu/lobby: silence ALL tips
    this.matchMemory    = [];     // running log of the match (rounds, streaks, reads)
    this.recentFrames   = [];     // last few REAL gameplay frames (never lobby/desktop)
    this.focusIndex     = -1;     // rotates analysis emphasis (map/enemies/…)
    this.analyzedFrames = 0;      // frames analyzed this session (warm-up gate)
    this.lastDeathAt    = 0;      // when the player last died (death-review window)

    this.timers = [];
    this.loopTimer = null;
    this.agentTimer = null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.paused = false;
    this.shouldAbort = false;
    this.lastTipTime = 0;
    this.matchContext = freshContext();
    this.aiTipCount = 0;
    this.libraryTipCount = 0;
    this.warnedFailure = false;
    this.warnedCapture = false;
    this.failStreak = 0;
    this.enemyHistory = [];
    this.lastWarnedSpot = null;
    this.recentAbilities = [];
    this.lastPhaseChange = null;
    this.inLobby = false;
    this.matchMemory = [];
    this.recentFrames = [];
    this.analyzedFrames = 0;
    this.lastDeathAt = 0;
    this.emit('status', 'coaching');

    this.timers.push(setTimeout(() =>
      this.isRunning && this.emitTip(welcomeMessage(), 'system'), TIMING.welcomeDelay));

    this.timers.push(setTimeout(() => this.isRunning && this.detectAgent(), TIMING.agentDetectFirst));
    this.agentTimer = setInterval(() => {
      if (!this.isRunning) return;
      if (this.matchContext.agent) { clearInterval(this.agentTimer); this.agentTimer = null; return; }
      this.detectAgent();
    }, TIMING.agentDetectRetry);

    // If detection hasn't locked an agent shortly after the first attempt, ask
    // the player directly (panel switches the bubble to a "type your agent" field).
    this.timers.push(setTimeout(() => {
      if (this.isRunning && !this.matchContext.agent) this.emit('agent', this.agentInfo());
    }, 9000));

    this.timers.push(setTimeout(() => this.isRunning && this.captureAndAnalyze(), TIMING.firstAnalyze));
    this.loopTimer = setInterval(() => {
      if (this.isRunning && !this.isCapturing) this.captureAndAnalyze();
    }, this.analyzeInterval);

    console.log('[engine] started, interval', this.analyzeInterval, 'ms, key', this.licenseKey ? 'set' : 'MISSING');
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.shouldAbort = true;
    this.timers.forEach(clearTimeout); this.timers = [];
    if (this.loopTimer)  { clearInterval(this.loopTimer);  this.loopTimer = null; }
    if (this.agentTimer) { clearInterval(this.agentTimer); this.agentTimer = null; }
    // Frame memory is session-scoped: the controller archives what it needs
    // BEFORE calling stop(), then the buffer is wiped so nothing carries over.
    this.recentFrames = [];
    this.emit('status', 'stopped');

    const aiTips = this.tipHistory.filter((t) => t.source === 'ai').length;
    if (aiTips >= 3) this.requestMatchReview();
    console.log('[engine] stopped');
  }

  pause() {
    if (!this.isRunning || this.paused) return;
    this.paused = true;
    this.emit('status', 'paused');
    console.log('[engine] paused');
  }

  resume() {
    if (!this.isRunning || !this.paused) return;
    this.paused = false;
    this.emit('status', 'coaching');
    console.log('[engine] resumed');
  }

  setPerformanceMode(mode) {
    const next = PERFORMANCE_INTERVALS[mode];
    if (!next || next === this.analyzeInterval) return;
    this.analyzeInterval = next;
    this.pacing = TIP_PACING[mode] || TIP_PACING.balanced;
    if (this.isRunning && this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = setInterval(() => {
        if (this.isRunning && !this.isCapturing) this.captureAndAnalyze();
      }, this.analyzeInterval);
      console.log('[engine] interval updated to', next, 'ms');
    }
  }

  // ── main loop ───────────────────────────────────────────────────────────────
  async captureAndAnalyze() {
    if (this.isCapturing || this.paused) return;
    if (Date.now() - this.lastCaptureTime < this.analyzeInterval - 2000) return;

    this.isCapturing = true;
    this.lastCaptureTime = Date.now();
    try {
      let shot;
      try { shot = await this.captureFunction(); }
      catch (e) { console.error('[engine] capture error:', e.message); this.onCaptureFailed(); return; }
      if (this.shouldAbort) return;
      if (!shot) { this.onCaptureFailed(); return; }
      this.warnedCapture = false;   // capture is healthy

      const body = { image: shot, context: this.buildOutgoingContext() };
      // Frame memory only when it earns its latency (two images are ~2x slower
      // per reply, and the loop is single-in-flight, so every slow reply costs
      // future tips): right after a death, on a phase flip, or as a periodic
      // pattern sample. Everything else sends one image and replies fast.
      const prev = this.shouldSendFrameMemory() ? this.previousGameplayFrame() : null;
      if (prev) body.previousImage = prev;

      const data = await this.callServer(API.ANALYZE, body);
      if (this.shouldAbort) return;
      if (!data) { this.onAnalyzeFailed(); return; }
      this.warnedFailure = false;   // server is healthy again
      this.failStreak = 0;
      this.analyzedFrames++;
      this.processAIResponse(data);
      if (!this.inLobby) this.pushFrame(shot);   // confirmed gameplay: keep for chat
    } catch (e) {
      console.error('[engine] analyze error:', e.message);
    } finally {
      this.isCapturing = false;
    }
  }

  async detectAgent() {
    if (this.matchContext.agent || this.isCapturing || this.paused) return;
    this.isCapturing = true;
    try {
      const shot = await this.captureFunction();
      if (!shot || this.shouldAbort) return;
      const data = await this.callServer(API.DETECT_AGENT, { image: shot });
      // Normalise whatever the server returns ("reyna", "KAY/O", "Jett ") to a
      // canonical name so detection reliably fires the confirm bubble.
      const detected = data && data.agent ? agentData.resolveName(data.agent) : null;
      if (detected) {
        this.matchContext.agent = detected;
        this.matchContext.agentConfirmed = false; // ask the player to confirm
        console.log('[engine] agent detected:', detected, '(raw:', data.agent + ')');
        if (this.agentTimer) { clearInterval(this.agentTimer); this.agentTimer = null; }
        this.emit('agent', this.agentInfo());
      }
    } catch (e) {
      console.error('[engine] detect-agent error:', e.message);
    } finally {
      this.isCapturing = false;
    }
  }

  // ── agent confirmation ────────────────────────────────────────────────────
  // The panel shows a bubble asking "Playing <X>?". A ✓ confirms the detection;
  // an ✗ lets the player type their agent. Until an agent is known, AI tips that
  // name a specific ability are held back (we can't verify they apply).
  agentInfo() {
    const agent = this.matchContext.agent;
    return {
      agent,
      confirmed: !!this.matchContext.agentConfirmed,
      role: agentData.getRole(agent),
    };
  }

  /** Player tapped ✓, trust the detected agent and stop re-detecting. */
  confirmAgent() {
    if (!this.matchContext.agent) return this.agentInfo();
    this.matchContext.agentConfirmed = true;
    if (this.agentTimer) { clearInterval(this.agentTimer); this.agentTimer = null; }
    console.log('[engine] agent confirmed:', this.matchContext.agent);
    this.emit('agent', this.agentInfo());
    return this.agentInfo();
  }

  /** Player typed their agent, override detection and lock it in. */
  setAgent(name) {
    const canonical = agentData.resolveName(name);
    if (!canonical) return { ok: false, error: 'unknown agent', agent: this.matchContext.agent };
    this.matchContext.agent = canonical;
    this.matchContext.agentConfirmed = true;
    if (this.agentTimer) { clearInterval(this.agentTimer); this.agentTimer = null; }
    console.log('[engine] agent set by player:', canonical);
    this.emit('agent', this.agentInfo());
    return { ok: true, ...this.agentInfo() };
  }

  async requestTip() {
    if (!this.isRunning || this.isCapturing) return;
    this.isCapturing = true;
    try {
      let shot;
      try { shot = await this.captureFunction(); }
      catch (e) { console.error('[engine] capture error (forced):', e.message); this.onCaptureFailed(true); return; }
      if (this.shouldAbort) return;
      if (!shot) { this.onCaptureFailed(true); return; }
      this.warnedCapture = false;
      const body = { image: shot, context: this.buildOutgoingContext() };
      const prev = this.previousGameplayFrame();
      if (prev) body.previousImage = prev;
      const data = await this.callServer(API.ANALYZE, body, { forced: true });
      if (!data) {
        // Forced press must always produce something useful.
        this.onAnalyzeFailed(true);
        return;
      }
      this.warnedFailure = false;
      this.failStreak = 0;
      if (data.context) this.updateMatchContext(data.context);

      const tip = String(data.tip || '').trim();
      if (tip.toUpperCase() !== 'LOBBY') this.pushFrame(shot);   // keep gameplay frame for chat
      if (tip.length > 10 && tip.toUpperCase() !== 'SKIP' && tip.toUpperCase() !== 'LOBBY') {
        this.emitTip(agentData.genericizeAbilities(cleanTip(tip)), 'ai');
      } else {
        // Forced and nothing from AI → guarantee a relevant library tip.
        this.emitLibraryTip({ force: true, ignoreRatio: true });
      }
    } catch (e) {
      console.error('[engine] forced tip error:', e.message);
      this.emitLibraryTip({ force: true, ignoreRatio: true }); // manual press always returns something
    } finally {
      this.isCapturing = false;
    }
  }

  async callServer(path, body, opts = {}) {
    try {
      const headers = opts.forced ? { 'X-Forced': 'true' } : undefined;
      // 16s: past the server's own worst-case AI timeout (13s on two-frame
      // analyses) plus network, so slow successes never read as failures,
      // while a genuinely hung request stalls the single-in-flight loop for
      // as short a time as possible.
      const { ok, status, data } = await api.post(path, body, this.licenseKey, 16000, headers);
      this.lastServerStatus = status;
      if (!ok) { console.error('[engine] server', path, 'status', status); return null; }
      return data;
    } catch (e) {
      this.lastServerStatus = 0; // network/unreachable
      console.error('[engine] server', path, 'error:', e.message);
      return null;
    }
  }

  /** Server gave us nothing, explain why once, then keep the overlay alive. */
  onAnalyzeFailed(force = false) {
    // A rejected license key (401/403) → ask the controller to re-validate now.
    // Throttled so a burst of failures doesn't spam the license endpoint.
    if ((this.lastServerStatus === 401 || this.lastServerStatus === 403) &&
        Date.now() - this.lastAuthSuspect > 60000) {
      this.lastAuthSuspect = Date.now();
      this.emit('auth-suspect');
    }
    // One miss is a hiccup (a slow AI reply, a dropped packet), NOT an outage:
    // stay quiet and let the next cycle succeed. Only a streak is worth a
    // warning, so the player never sees "can't reach" while things still work.
    this.failStreak++;
    if (!force && this.failStreak < 2) return;
    if (!this.warnedFailure) {
      this.warnedFailure = true;
      let msg;
      if (!this.licenseKey) {
        msg = 'No license picked up, AI coaching’s off. Running library tactics for now.';
      } else if (this.lastServerStatus === 401 || this.lastServerStatus === 403) {
        msg = 'Your license isn’t active, re-activate in Settings. Library tactics for now.';
      } else if (this.lastServerStatus >= 500) {
        msg = 'The coach’s AI is temporarily down on the server, running library tactics till it’s back.';
      } else {
        msg = 'Can’t reach the coach server right now, running library tactics till it’s back.';
      }
      this.emitTip(msg, 'system');
      if (!force) return; // periodic loop: next cycle starts the library cadence
    }
    this.emitLibraryTip({ force, ignoreRatio: true }); // AI unavailable → ratio doesn't apply
  }

  /** Screen capture failed (e.g. antivirus block), surface it, stay useful. */
  onCaptureFailed(force = false) {
    if (!this.warnedCapture) {
      this.warnedCapture = true;
      this.emitTip('Windows blocked screen capture. Add GhostCoach to your antivirus exclusions (Windows Security, Virus and threat protection, Exclusions), then restart coaching.', 'system');
      if (!force) return;
    }
    this.emitLibraryTip({ force, ignoreRatio: true }); // capture down → ratio doesn't apply
  }

  // ── context sent to the server ───────────────────────────────────────────────
  // Enriches each request with recent round history, the locked agent's role,
  // tracked enemy positions, and a rotating focus hint so a good share of frames
  // emphasise the minimap / economy / enemy reads.
  buildOutgoingContext() {
    const recentTopics = this.tipHistory.slice(-3).map((t) => topicOf(t.text));
    const recentTips   = this.tipHistory.slice(-4).map((t) => t.text);
    // Only tell the server the agent once the PLAYER has confirmed it. On a mere
    // detection guess we send agent:null so the AI stays general and never names
    // an ability (no "use stim beacon" before they've confirmed Brimstone).
    const confirmedAgent = this.matchContext.agentConfirmed ? this.matchContext.agent : null;
    return {
      ...this.matchContext,
      agent:        confirmedAgent,
      recentTopics,
      recentTips,
      enemyHistory: this.enemyHistory.slice(-6),
      phaseTransition: this.recentPhaseTransition(),
      badTips: [...this.badTips].slice(0, 6),
      matchMemory: this.matchMemory.slice(-10),
      playerStats: this.playerStats,
      agentRole:    agentData.getRole(confirmedAgent),
      teammates:    this.matchContext.teammates || null, // passthrough if the server reports the comp
      // Death review: the player died moments ago, the server prompts for a
      // cause-and-fix explanation ONLY when the evidence clearly supports one.
      justDied:     this.lastDeathAt > 0 && Date.now() - this.lastDeathAt < 12000,
      focus:        this.nextFocus(),
      // Experimental: playbook mode ('off' | 'on' | 'hybrid') for the server.
      proPlaybook:  this.experiments().proPlaybook || 'off',
      // Tell the coach how we want advice phrased / scoped. Greyed-out (unbought
      // or on-cooldown) abilities show dimmed in-game; only the AI vision can read
      // that, so we ask it to respect it and to keep ability talk generic.
      coachingPrefs: {
        genericAbilities: true,        // say "smoke"/"flash", not agent-specific names
        teamAware: true,               // consider the player's teammates' agents
        onlyAvailableAbilities: true,  // don't suggest greyed-out / unbought abilities
      },
    };
  }

  /** "buy->active" while a phase flip is fresh (~10s), else null. */
  recentPhaseTransition() {
    const pc = this.lastPhaseChange;
    return pc && Date.now() - pc.at < 10000 ? `${pc.from}->${pc.to}` : null;
  }

  nextFocus() {
    // Some frames emphasise the minimap / enemy reads; 'teammates' and
    // 'abilities' nudge the coach to factor in the comp and what's actually
    // usable. (economy was retired: buy advice is banned, reads stay context.)
    const foci = ['map', 'enemies', 'positioning', 'utility', 'aim', 'teammates', 'abilities'];
    this.focusIndex = (this.focusIndex + 1) % foci.length;
    return foci[this.focusIndex];
  }

  // ── enemy pattern tracking ────────────────────────────────────────────────────
  // Reads whatever enemy-location signal the AI returns in response.context and,
  // if the same spot shows up repeatedly, warns the player to pre-aim it.
  extractEnemySpot(ctx) {
    if (!ctx) return null;
    const cand = ctx.enemyAngle || ctx.enemySpot || ctx.enemyPosition ||
                 ctx.enemyLocation || ctx.lastSeenEnemy ||
                 (Array.isArray(ctx.enemyPositions) && ctx.enemyPositions.length === 1 ? ctx.enemyPositions[0] : null);
    return typeof cand === 'string' && cand.trim() ? cand.trim().toLowerCase() : null;
  }

  trackEnemy(ctx) {
    const spot = this.extractEnemySpot(ctx);
    if (!spot) return;
    this.enemyHistory.push(spot);
    if (this.enemyHistory.length > 8) this.enemyHistory.shift();

    // A repeated spot goes into MATCH MEMORY + ENEMY PATTERNS so the AI folds
    // the read into a real, situation-aware tip. (The old hardcoded "Heads up,
    // they keep swinging X" template tip is gone: templated spam, not coaching.)
    const recent  = this.enemyHistory.slice(-3);
    const repeats = recent.filter((s) => s === spot).length;
    if (repeats >= 2 && spot !== this.lastWarnedSpot) {
      this.lastWarnedSpot = spot;
      this.remember(`Enemies keep taking ${prettySpot(spot)}`);
    }
  }

  // ── response processing + guardrails ────────────────────────────────────────
  processAIResponse(response) {
    if (response.context) { this.updateMatchContext(response.context); this.trackEnemy(response.context); }

    const raw = response.tip;
    if (!raw) return;
    let tip = String(raw).trim();

    if (tip.startsWith('{') || tip.includes('"tip"')) {            // raw JSON
      console.log('[engine] reject: JSON-looking tip');
      return;
    }
    if (PREAMBLE.some((re) => re.test(tip))) {                     // AI preamble
      console.log('[engine] reject: preamble');
      return;
    }

    tip = tip.replace(/^["']/, '').replace(/["']$/, '').trim();

    if (tip.toUpperCase() === 'LOBBY') {
      // Not live gameplay (main menu / lobby / loading): total silence, no
      // AI tips and no library filler, until real gameplay is seen again.
      if (!this.inLobby) console.log('[engine] lobby detected, tips muted');
      this.inLobby = true;
      this.skipCount = 0;
      return;
    }
    this.inLobby = false;   // any non-LOBBY answer means we are in gameplay

    // Warm-up: the first frames of a session build context (side, phase,
    // memory, patterns). A tip with no context behind it is a guess, so the
    // state still updates above but nothing is coached yet.
    if (this.analyzedFrames < 2) {
      console.log('[engine] warm-up frame, gathering context only');
      return;
    }

    if (tip.toUpperCase() === 'SKIP' || tip.length < 20) {         // skip / too short
      this.skipCount++;
      // One SKIP plus a real quiet spell is enough for the library to step in;
      // waiting for two consecutive SKIPs starved the overlay of tips.
      if (this.skipCount >= 1 && Date.now() - this.lastTipTime > this.pacing.silence) {
        this.skipCount = 0;
        // AI went quiet: fill in with a library tip, but keep it within the mix
        // budget so library stays a minority (<=35%). The player wants majority
        // AI, so we accept a little quiet over drowning it in filler.
        this.emitLibraryTip();
      }
      return;
    }
    if (TRUNCATION.some((re) => re.test(tip))) { console.log('[engine] reject: truncated'); return; }
    if (!/[.!?"]$/.test(tip))                  { console.log('[engine] reject: incomplete'); return; }
    if (tip.split(/\s+/).length > 24)          { console.log('[engine] reject: too long'); return; }
    // A fresh phase flip (round start, spike planted) opens a short window where
    // a timely tip beats the normal pacing, so the cooldown relaxes.
    const cooldown = this.recentPhaseTransition() ? Math.min(6000, this.pacing.cooldown) : this.pacing.cooldown;
    if (Date.now() - this.lastTipTime < cooldown) { console.log('[engine] reject: cooldown'); return; }

    const cleaned = agentData.genericizeAbilities(cleanTip(tip));
    if (this.isSimilarToRecent(cleaned)) { console.log('[engine] reject: similar'); return; }

    const topic = topicOf(cleaned);
    const recent = this.tipHistory.slice(-3).map((t) => topicOf(t.text));
    if (recent.filter((t) => t === topic).length >= 2) { console.log('[engine] reject: topic cooldown'); return; }

    if (!this.validateTipForAgent(cleaned)) {
      console.log('[engine] reject: wrong-agent ability');
      this.emitLibraryTip();   // swap in a solid general tip instead of silence
      return;
    }

    // Anti-fixation: don't suggest the same ability (e.g. Updraft) in back-to-back
    // tips. Forces variety even if the model repeats itself.
    const abilityWord = abilityWordIn(cleaned);
    if (abilityWord && this.recentAbilities.slice(-2).includes(abilityWord)) {
      console.log('[engine] reject: ability fixation (' + abilityWord + ')');
      this.emitLibraryTip();
      return;
    }

    this.skipCount = 0;
    const sent = this.emitTip(cleaned, 'ai');
    if (sent && abilityWord) {
      this.recentAbilities.push(abilityWord);
      if (this.recentAbilities.length > 6) this.recentAbilities.shift();
    }
    // Verify gate dropped it (cut-off, scenario mismatch, ability the player
    // can't use, etc): cover the gap with a situation-appropriate library tip.
    if (!sent) this.emitLibraryTip();
  }

  /**
   * Emit a fallback library tip.
   * @param {object} opts
   *   force, bypass the per-tip cooldown (manual press / failure mode)
   *   ignoreRatio, bypass the AI-majority governor (only when AI is unavailable:
   *                 server/capture down, or a manual press the user asked for)
   */
  emitLibraryTip(opts = {}) {
    const { force = false, ignoreRatio = false } = (typeof opts === 'boolean' ? { force: opts } : opts);
    if (this.inLobby && !force) return;   // in a menu/lobby: no filler tips at all
    if (this.analyzedFrames < 2 && !force) return;   // warm-up: context before coaching
    if (!force && Date.now() - this.lastTipTime < this.pacing.cooldown) return;

    // Keep AI the majority: while the AI is available, a "filler" library tip
    // only fires if it won't push AI's share below the configured floor.
    if (!ignoreRatio && !this.libraryWithinBudget()) {
      console.log('[engine] library tip suppressed, preserving AI majority',
        `(ai=${this.aiTipCount} lib=${this.libraryTipCount})`);
      return;
    }

    // Recently shown + player-rated-bad texts are both off the menu.
    const recentTexts = [...this.tipHistory.slice(-16).map((t) => t.text), ...this.badTips];

    // Occasionally drop an agent-specific reminder, but only once the player has
    // CONFIRMED the agent; on a mere guess we stick to general tips.
    const agentTip = this.matchContext.agentConfirmed
      ? agentData.getAgentTip(this.matchContext.agent) : null;
    if (agentTip && !recentTexts.includes(agentTip) && Math.random() < 0.22) {
      this.emitTip(agentTip, 'library');
      return;
    }

    const { text } = tipLibrary.selectTip(this.matchContext, recentTexts);
    if (text) this.emitTip(text, 'library');
  }

  /** Tracker profile arrived: every subsequent analyze request carries it so
   *  the AI calibrates advice to the player's actual rank and weaknesses. */
  setPlayerStats(stats) {
    this.playerStats = stats && !stats.error ? stats : null;
    if (this.playerStats) console.log('[engine] player stats loaded:', this.playerStats.rank || 'unknown rank');
  }

  /** Keep the last few frames of REAL gameplay so the chat can show the player
   *  what the coach is talking about. Only called after the server confirmed
   *  the frame is not a lobby/menu, so a desktop or lobby shot never lands here. */
  pushFrame(image) {
    if (!image) return;
    this.recentFrames.push({ image, at: Date.now(), phase: this.matchContext.phase });
    if (this.recentFrames.length > 5) this.recentFrames.shift();
  }

  /** Frame memory (always on, session-scoped): the newest CONFIRMED gameplay
   *  frame, only while fresh enough to still describe "a moment ago" (90s).
   *  Frames land in recentFrames after the server verifies them, so a lobby
   *  or desktop shot can never be sent as the previous frame. The buffer is
   *  wiped on stop() and rebuilt fresh by the next session. */
  previousGameplayFrame() {
    const last = this.recentFrames[this.recentFrames.length - 1];
    return last && Date.now() - last.at < 90000 ? last.image : null;
  }

  /** Frame memory is worth the extra latency when change is the story: the
   *  player just died (explain it), the phase just flipped, or every 3rd
   *  frame as a pattern sample. The rest of the time one fast image wins. */
  shouldSendFrameMemory() {
    if (this.matchContext.lastDeathAt && Date.now() - this.matchContext.lastDeathAt < 15000) return true;
    if (this.recentPhaseTransition()) return true;
    return this.analyzedFrames % 3 === 2;
  }

  /** Append one line to the match memory (deduped, capped) so the AI keeps a
   *  running picture of the match instead of judging every frame cold. */
  remember(line) {
    if (!line || this.matchMemory[this.matchMemory.length - 1] === line) return;
    this.matchMemory.push(line);
    if (this.matchMemory.length > 16) this.matchMemory.shift();
  }

  /** Player rated a tip as bad: blocklist it and avoid its topic for a while. */
  noteBadTip(text) {
    if (!text) return;
    this.badTips.add(text);
    console.log('[engine] bad-tip feedback:', topicOf(text), '|', String(text).slice(0, 50));
  }

  /** Current AI vs library coaching-tip mix this session. */
  getMix() {
    const total = this.aiTipCount + this.libraryTipCount;
    return {
      ai: this.aiTipCount,
      library: this.libraryTipCount,
      aiShare: total ? this.aiTipCount / total : 0,
    };
  }

  /** Would adding one library tip keep AI's share >= the configured floor? */
  libraryWithinBudget() {
    const sent = this.aiTipCount + this.libraryTipCount;
    if (sent < COACHING.bootstrapLibrary) return true; // avoid early dead-air
    const total = sent + 1; // include the prospective tip
    return (this.aiTipCount / total) >= COACHING.aiMinShare;
  }

  /**
   * The single exit for EVERY tip. Runs the synchronous verifier (grammar,
   * cut-off, usefulness, scenario fit) and drops anything that doesn't pass, so
   * nothing malformed or unhelpful ever reaches the overlay. No network → no
   * added latency. Returns true if the tip was actually sent.
   */
  emitTip(text, source) {
    const verified = verifyTip(text, source, this.matchContext);
    if (!verified) { console.log(`[engine] reject(verify/${source}): ${text}`); return false; }

    const tip = { text: verified, source, time: Date.now() };
    if (source !== 'system') {                       // status notices aren't coaching history
      this.tipHistory.push(tip);
      if (this.tipHistory.length > 50) this.tipHistory.shift();
      if (source === 'ai') this.aiTipCount++;
      else if (source === 'library') this.libraryTipCount++;
    }
    this.lastTipTime = Date.now();
    console.log(`[engine] TIP (${source}): ${verified}  [ai=${this.aiTipCount} lib=${this.libraryTipCount}]`);
    this.emit('tip', tip);
    return true;
  }

  isSimilarToRecent(newTip) {
    const words = new Set(newTip.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    if (!words.size) return false;
    for (const old of this.tipHistory.slice(-10)) {
      const oldWords = new Set(old.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      if (!oldWords.size) continue;
      const overlap = [...words].filter((w) => oldWords.has(w)).length;
      if (overlap / Math.min(words.size, oldWords.size) > 0.5) return true;
    }
    return false;
  }

  validateTipForAgent(tip) {
    const playerAgent = this.matchContext.agent;
    if (!playerAgent) return true;
    const lower = tip.toLowerCase();
    for (const name of agentData.allNames()) {
      if (name === playerAgent) continue;
      for (const ability of agentData.getAbilities(name)) {
        // only match distinctive ability names to avoid false positives on
        // generic words like "dash" / "slow"
        if ((ability.includes(' ') || ability.includes('/') || ability.length >= 6) && lower.includes(ability)) {
          if (lower.includes('teammate') || lower.includes("'s ")) return true;
          return false;
        }
      }
    }
    return true;
  }

  updateMatchContext(updates) {
    const prevPhase = this.matchContext.phase;
    const prevRound = this.matchContext.roundNumber;
    const prevTeam  = this.matchContext.teamScore  | 0;
    const prevEnemy = this.matchContext.enemyScore | 0;

    for (const key of Object.keys(updates)) {
      const v = updates[key];
      if (v === null || v === undefined) continue;
      if (key === 'agent' || key === 'map') {            // locked once set
        if (!this.matchContext[key]) this.matchContext[key] = v;
        continue;
      }
      if (key === 'recentTopics') continue;
      this.matchContext[key] = v;
    }

    if (typeof updates.roundNumber === 'number' && updates.roundNumber > prevRound) {
      this.matchContext.roundsPlayed++;
    }
    // Round-transition awareness: note phase flips (buy -> active -> postplant …)
    // so the next request coaches the NEW phase and the cooldown briefly relaxes.
    if (updates.phase && updates.phase !== prevPhase) {
      this.lastPhaseChange = { from: prevPhase, to: updates.phase, at: Date.now() };
    }
    if (updates.phase === 'dead' && prevPhase !== 'dead') {
      this.matchContext.consecutiveDeaths++;
      this.matchContext.consecutiveWins = 0;
      this.lastDeathAt = Date.now();   // opens the death-review window
      this.matchContext.lastDeathAt = this.lastDeathAt;   // visible to the tip verifier
      this.remember(`Player died round ${(this.matchContext.teamScore | 0) + (this.matchContext.enemyScore | 0) + 1}`);
      if (this.matchContext.consecutiveDeaths >= 2) {
        this.remember(`Player has died ${this.matchContext.consecutiveDeaths} rounds in a row`);
      }
    }
    if (updates.phase === 'active' && prevPhase === 'dead') {
      this.matchContext.consecutiveDeaths = 0;
    }

    // Match memory: record round outcomes from score changes so future tips
    // know the flow of the match, not just the current frame.
    const team  = this.matchContext.teamScore  | 0;
    const enemy = this.matchContext.enemyScore | 0;
    if (team > prevTeam)  this.remember(`Won round ${team + enemy} (score ${team}-${enemy})`);
    if (enemy > prevEnemy) this.remember(`Lost round ${team + enemy} (score ${team}-${enemy})`);
  }

  async requestMatchReview() {
    try {
      const tips = this.tipHistory.filter((t) => t.source === 'ai').map((t) => t.text);
      const data = await this.callServer(API.MATCH_REVIEW, {
        tips,
        context: { ...this.matchContext, proPlaybook: this.experiments().proPlaybook || 'off' },
      });
      if (data && data.review) this.emit('match-review', data.review);
    } catch (e) {
      console.error('[engine] match-review error:', e.message);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function freshContext() {
  return {
    agent: null, agentConfirmed: false, map: null, side: null, teammates: null,
    roundNumber: 0, teamScore: 0, enemyScore: 0,
    phase: 'unknown', playerCredits: null, playerWeapon: null, playerAlive: true,
    teammatesAlive: null, enemiesAlive: null,   // reported by the AI from the HUD bar
    consecutiveDeaths: 0, consecutiveWins: 0, roundsPlayed: 0,
  };
}

function cleanTip(tip) {
  return tip.replace(/ - /g, ', ').trim();
}

function topicOf(text) {
  const l = (text || '').toLowerCase();
  if (/buy|credit|economy|save|spectre|vandal|phantom|shield|pistol|eco|force/.test(l)) return 'economy';
  if (/peek|wide|jiggle|swing|reposition|off.angle/.test(l)) return 'peeking';
  if (/flash|smoke|drone|molly|util/.test(l)) return 'utility';
  if (/crosshair|aim|head|tap|spray|strafe/.test(l)) return 'aim';
  if (/rotate|rotation|lurk|minimap/.test(l)) return 'rotation';
  if (/spike|plant|defus|retake|post.plant/.test(l)) return 'spike';
  if (/team|trade|comm|callout/.test(l)) return 'teamwork';
  if (/tilt|mental|focus|breath|calm|reset/.test(l)) return 'mental';
  if (/dead|died|death|spectat/.test(l)) return 'death';
  return 'general';
}

const PREAMBLE = [
  /^here is/i, /^here's/i, /^sure[,!]/i, /^okay[,!]/i, /^the json/i,
  /^as requested/i, /^based on/i, /^analyzing/i, /^looking at/i, /^i'll/i, /^i can/i,
];
const TRUNCATION = [
  // dangling connectives / articles / prepositions
  /\band\.?$/i, /\bor\.?$/i, /\bbut\.?$/i, /\bto\.?$/i, /\bwith\.?$/i, /\bfor\.?$/i,
  /\bthe\.?$/i, /\ba\.?$/i, /\ban\.?$/i, /\bof\.?$/i, /\bin\.?$/i, /\bat\.?$/i,
  /\bon\.?$/i, /\byour\.?$/i, /\bmy\.?$/i, /'s\.?$/i, /,\s*$/,
  // transitive verbs that normally need an object: as the LAST word they mean
  // the model got cut off ("...health, play." / "...so you can take.")
  /\bplay\.?$/i, /\btake\.?$/i, /\buse\.?$/i, /\busing\.?$/i, /\bthrow\.?$/i,
  /\bget\.?$/i, /\bkeep\.?$/i, /\bsave\.?$/i, /\bset\.?$/i, /\bput\.?$/i, /\bgo\.?$/i,
  /\bdeploy\.?$/i, /\bpop\.?$/i, /\bforce\.?$/i, /\bline\.?$/i, /\bpre\.?$/i,
  /\bbait\.?$/i, /\bgrab\.?$/i, /\bhit\.?$/i, /\bavoid\.?$/i, /\bwatch\.?$/i,
];

const WELCOME_MESSAGES = [
  'Locked in with you, let’s get some frags. Play smart out there.',
  'Coach is live. Trust your reads and stay tradeable.',
  'Watching every round with you. Let’s climb.',
  'GhostCoach on. Breathe, lock in, play your game.',
  'We’re live, time to cook. GLHF.',
];
function welcomeMessage() {
  return WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
}

// Tidy a raw enemy-spot token into a readable callout, e.g. "a_main" → "A Main".
function prettySpot(spot) {
  return String(spot).replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

// AI refusals / placeholders that are never a real coaching tip.
const NONSENSE = /\b(i cannot|i can.?t|i.?m sorry|as an ai|i am unable|unable to|no tip|not applicable|n\/a|cannot determine|undefined|null)\b/i;

// Ability keywords used to stop the coach fixating on one ability across tips.
// Precompiled into word-boundary regexes once; this runs on every AI tip.
const ABILITY_WORDS = ['updraft', 'dash', 'satchel', 'sprint', 'smoke', 'flash', 'molly',
  'wall', 'recon', 'drone', 'camera', 'tripwire', 'trap', 'dart', 'stun', 'blind',
  'teleport', 'heal', 'turret', 'sensor', 'decoy', 'shock', 'bubble']
  .map((w) => [w, new RegExp('\\b' + w + '\\b')]);
function abilityWordIn(text) {
  const l = String(text || '').toLowerCase();
  for (const [w, re] of ABILITY_WORDS) if (re.test(l)) return w;
  return null;
}

function countOf(str, ch) {
  let n = 0;
  for (const c of str) if (c === ch) n++;
  return n;
}

/**
 * Final gate applied to EVERY tip before it reaches the overlay. Purely
 * synchronous (regex/string only, no network), so verification is instant.
 * Returns the cleaned text to send, or null to drop the tip.
 *
 *   grammar    capitalised, single-spaced, no doubled words, balanced quotes
 *   cut-off    must end on a complete sentence; trailing connectives = chopped
 *   useful     not too thin, not a refusal/placeholder (coaching tips only)
 *   scenario   fits the current situation (coaching tips only)
 *
 * System status notices skip the useful/scenario rules, they must always show
 * (e.g. the antivirus warning), but still get grammar + cut-off cleanup.
 */
function verifyTip(rawText, source, ctx) {
  if (rawText == null) return null;
  let t = String(rawText).replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // grammar tidy: kill em/en dashes (never allowed), fix punctuation spacing,
  // collapse doubled words (genericiser residue)
  t = t.replace(/\s*[\u2014\u2013]\s*/g, ', ')
       .replace(/\s+([.,!?;:])/g, '$1')
       .replace(/,\s*,/g, ',')
       .replace(/\b(a|an|the|to|your|and|or|of|on|in)\s+\1\b/gi, '$1')
       .replace(/\s{2,}/g, ' ')
       .trim();
  if (/^[a-z]/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);

  // must end on a complete sentence; otherwise rescue to the last one, else drop
  if (!/[.!?]["')]?$/.test(t)) {
    const m = t.match(/^.*[.!?]["')]?/);
    if (m && m[0].trim().split(/\s+/).length >= 4) t = m[0].trim();
    else return null;
  }

  // malformed punctuation (any source)
  if (countOf(t, '(') !== countOf(t, ')')) return null;
  if (countOf(t, '"') % 2 !== 0) return null;
  // dangling-connective truncation is an AI artefact; curated library/system
  // tips are authored complete and may legitimately end on words like "in".
  if (source === 'ai' && TRUNCATION.some((re) => re.test(t))) return null;

  const words = t.split(/\s+/);
  if (words.length > 30) return null;            // genuinely rambling (the card wraps to fit)

  if (source !== 'system') {
    if (words.length < 4) return null;           // too thin to be actionable
    if (NONSENSE.test(t)) return null;           // AI refusal / placeholder
    if (!scenarioFits(t, source, ctx)) return null;
  }
  return t;
}

// Non-actionable "meta" advice, nothing the player can do in the moment.
const META_ADVICE = /\b(combat report|scoreboard|tab (?:menu|key|screen|out)|match history|post[- ]?game|kill ?feed|the report)\b/i;

// Economy/buy advice is retired (player feedback: inaccurate and low value).
// The AI keeps the economy as CONTEXT for reads, but any tip that tells the
// player what to buy, save, force, or drop is dropped here.
const ECON_TIP = new RegExp([
  '\\bfull ?buy\\b', '\\bforce ?buy\\b', '\\bhalf ?buy\\b', '\\beco(?:nomy)?\\b',
  '\\bfull save\\b', '\\bsave (?:your |the )?(?:creds?|credits?|money|gun|rifle|weapon)\\b',
  '\\bcredits?\\b', '\\b(?:light|full|half|heavy|buy(?:ing)?) shields?\\b', '\\barmor\\b',
  '\\b(?:buy|purchase|rebuy)\\b(?!\\s+(?:you|yourself|your team|us|them|some)?\\s*(?:time|seconds|space))',
  "\\bteam'?s buy\\b", '\\bdrop (?:a |your |him |her |them )?(?:gun|weapon|rifle)\\b',
].join('|'), 'i');

// Mobility abilities cannot clear, check, or watch anything. "Use Updraft to
// clear the flank" style tips are nonsense and get dropped outright.
const MOBILITY_MISUSE = new RegExp(
  '\\b(updraft|tailwind|dash(?:es)?|satchel|blast pack|high gear|sprint|blink|gatecrash)\\b[^.]{0,44}\\b(clear|check|watch|scan|spot)\\b'
  + '|\\b(clear|check|watch|scan)(?:ing)?\\b[^.]{0,44}\\b(updraft|tailwind|satchel|high gear|sprint)\\b', 'i');

// Prompt-echo leaks: fragments of the STATE schema or frame-memory wording
// must never surface as a tip.
const PROMPT_LEAK = /"(?:side|phase|round|team|enemy|credits|alive|weapon|map|enemySpot)"|\bSTATE\b|\benemy ?spot\b|\b(?:previous|current|second) frame\b|\bplaybook\b/i;

// Updraft tips are permanently banned (player feedback: the model always gets
// them wrong). Knife tips are only allowed in the death-review window, i.e.
// when having the knife out plausibly just got the player killed; commentary
// on ordinary knife rotations is noise.
const UPDRAFT_BAN = /\bupdraft\b/i;
const KNIFE_TIP   = /\bknife\b/i;
const DEATH_WINDOW_MS = 15000;

// Advice that requires living teammates: impossible in a solo clutch
// (teammatesAlive reported as 0 by the AI from the HUD portraits).
const TEAM_PLAY_TIP = /\btrad(?:e|es|ed|ing)\b|\bteammates?\b|\bcrossfire\b|\bswing (?:with|together)\b|\bas five\b|\bregroup\b|\btrade partner\b|\bentry with\b/i;

// High-confidence situational guards only, never reject on a guess.
function scenarioFits(text, source, ctx) {
  if (!ctx) return true;
  const l = text.toLowerCase();

  // No "analyse the combat report"-style tips, give in-the-moment advice.
  if (source === 'ai' && META_ADVICE.test(l)) return false;

  // Economy/buy tips are retired entirely; mobility abilities can't "clear"
  // anything; and prompt internals never surface as coaching.
  if (source === 'ai' && ECON_TIP.test(l)) return false;
  if (MOBILITY_MISUSE.test(l)) return false;
  if (source !== 'system' && PROMPT_LEAK.test(text)) return false;
  // Solo clutch: nobody is alive to trade or crossfire with, so team-play
  // advice is impossible and gets dropped no matter how good it sounds.
  if (ctx.playerAlive !== false && ctx.teammatesAlive === 0 && TEAM_PLAY_TIP.test(l)) {
    return false;
  }

  // Updraft advice: never. Knife advice: only right after a death it may have caused.
  if (source !== 'system' && UPDRAFT_BAN.test(l)) return false;
  if (source !== 'system' && KNIFE_TIP.test(l)
      && !(ctx.lastDeathAt && Date.now() - ctx.lastDeathAt < DEATH_WINDOW_MS)) {
    return false;
  }

  // Don't tell the player to use an ability their agent can't (e.g. "recon
  // dart" on Reyna). With no confirmed agent, hold back ability-specific tips
  // until we know what they're on, this is the core "verify before tipping".
  // Treat the agent as unknown until the player CONFIRMS it, so a detection
  // guess never lets an ability-specific tip through.
  const gateAgent = ctx.agentConfirmed ? ctx.agent : null;
  if (source === 'ai') {
    // Before confirmation, block ANY named ability (e.g. "stim beacon"), not
    // just generic ones, so nothing agent-specific slips out on a guess.
    if (!gateAgent && agentData.mentionsSpecificAbility(text)) return false;
    if (agentData.tipMisusesAbility(text, gateAgent)) return false;
  }

  // A dead player can only watch / comm, don't tell them to peek or shoot.
  if (ctx.phase === 'dead'
      && /\b(peek|swing|shoot|spray|tap|push|rush|plant|defuse|reload)\b/.test(l)
      && !/\b(comm|call|callout|watch|spectat|info|next round|note)\b/.test(l)) {
    return false;
  }
  return true;
}

module.exports = CoachingEngine;
