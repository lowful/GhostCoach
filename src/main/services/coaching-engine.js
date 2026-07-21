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
 *   'tip'          { text, source: 'ai'|'library'|'system', time, death? (white skull death review) }
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
    this.perfSummary = null;   // coached-session category trends (dashboard overview)
    // Experimental settings, read live from the store so a settings flip
    // applies to the very next capture: { proPlaybook: 'off'|'on'|'hybrid' }.
    this.experiments = typeof opts.experiments === 'function' ? opts.experiments : () => ({});
    // Death forensics: fresh rolling game-audio clip getter (null when absent).
    this.audioClip = typeof opts.audioClip === 'function' ? opts.audioClip : () => null;
    // Player-written feedback on past tips ({ text, reason }), for the prompt.
    this.getFeedback = typeof opts.getFeedback === 'function' ? opts.getFeedback : () => [];

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
    this.playerNotes    = [];     // observed FACTS about what the player did on screen
    this.recentFrames   = [];     // last few REAL gameplay frames (never lobby/desktop)
    this.focusIndex     = -1;     // rotates analysis emphasis (map/enemies/…)
    this.analyzedFrames = 0;      // frames analyzed this session (warm-up gate)
    this.lastDeathAt    = 0;      // when the player last died (death-review window)
    this.lastRoundLostAt = 0;     // when the team last lost a round (round-review window)
    this.aliveFalseStreak = 0;    // consecutive alive:false reads (2 confirm a death)
    this.firstHalfSide    = null; // locked first-half side; halftime flip is then arithmetic
    this.pendingFirstSide = null; // needs two agreeing reads before locking
    // Game mode decides the halftime math: swiftplay halves are 4 rounds,
    // unrated/competitive halves are 12. Locked from two agreeing HUD reads,
    // from score/round arithmetic (a 6th round win or a 10th round can only
    // be a standard match), or from an observed side swap at round 5.
    this.pendingMode      = null; // vision-reported mode awaiting a 2nd agreeing read
    this.standardEvidence = 0;    // consecutive frames whose score/round prove standard
    this.swapEvidence     = 0;    // consecutive flipped side reads in rounds 5-8 (swiftplay tell)

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
    this.playerNotes = [];
    this.recentFrames = [];
    this.analyzedFrames = 0;
    this.lastDeathAt = 0;
    this.firstHalfSide = null;
    this.pendingFirstSide = null;
    this.pendingMode = null;
    this.standardEvidence = 0;
    this.swapEvidence = 0;
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
      // Death forensics: inside the death window the last seconds of game
      // audio ride along. The sounds (footsteps, reloads, ult voice lines)
      // usually explain a death better than any frame, and this is strictly
      // explanation, never "right now" reaction.
      if (this.matchContext.lastDeathAt && Date.now() - this.matchContext.lastDeathAt < 15000) {
        const clip = this.audioClip();
        if (clip) body.audio = clip;
      }

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
      if (tip.toUpperCase() === 'LOBBY') {
        // Not in a match (loading screen, agent select, menu): never coach it,
        // even on a manual press, but the button still deserves an answer.
        this.inLobby = true;
        this.emitTip('No live round on screen. Coaching kicks in the moment your match does.', 'system');
        return;
      }
      this.inLobby = false;
      this.pushFrame(shot);   // confirmed gameplay: keep for chat
      if (tip.length > 10 && tip.toUpperCase() !== 'SKIP') {
        const cleaned = agentData.genericizeAbilities(cleanTip(tip));
        // A manual press deserves a FRESH answer: a repeat of a recent tip
        // swaps to the library instead of echoing what is already on screen.
        if (this.isSimilarToRecent(cleaned)) {
          console.log('[engine] forced tip was a repeat, swapping to library');
        } else {
          const sent = this.emitTip(cleaned, 'ai', { death: !!data.death });
          if (sent) return;
          // Verify gate dropped the forced tip. This used to end in SILENCE (the
          // "force tip does nothing" bug); fall through to a guaranteed library tip.
        }
      }
      this.emitLibraryTip({ force: true, ignoreRatio: true });
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
      badTips: [...this.badTips].slice(0, 6),   // 3-strike blocked tips only
      tipFeedback: (this.getFeedback() || []).slice(-6),
      matchMemory: this.matchMemory.slice(-10),
      playerStats: this.playerStats,
      coachTrend:  this.perfSummary || null,   // dashboard category trends
      agentRole:    agentData.getRole(confirmedAgent),
      teammates:    this.matchContext.teammates || null, // passthrough if the server reports the comp
      // Death review: the player died moments ago, the server prompts for a
      // cause-and-fix explanation ONLY when the evidence clearly supports one.
      justDied:     this.lastDeathAt > 0 && Date.now() - this.lastDeathAt < 12000,
      justLostRound: this.lastRoundLostAt > 0 && Date.now() - this.lastRoundLostAt < 12000,
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
    if (response.context) {
      this.updateMatchContext(response.context);
      this.trackEnemy(response.context);
      // Observed fact about what the player actually DID (from the screen,
      // reported in STATE.note): the honest record reviews are written from.
      if (response.context.playerNote) this.addPlayerNote(response.context.playerNote);
    }

    const raw = response.tip;
    if (!raw) return;
    let tip = String(raw).trim();

    if (tip.startsWith('{') || tip.includes('"tip"')) {            // raw JSON
      console.log('[engine] reject: JSON-looking tip');
      this.fillQuietSpell();
      return;
    }
    if (PREAMBLE.some((re) => re.test(tip))) {                     // AI preamble
      console.log('[engine] reject: preamble');
      this.fillQuietSpell();
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
    if (TRUNCATION.some((re) => re.test(tip))) { console.log('[engine] reject: truncated'); this.fillQuietSpell(); return; }
    if (!/[.!?"]$/.test(tip))                  { console.log('[engine] reject: incomplete'); this.fillQuietSpell(); return; }
    // A fresh phase flip (round start, spike planted) opens a short window where
    // a timely tip beats the normal pacing, so the cooldown relaxes.
    const cooldown = this.recentPhaseTransition() ? Math.min(6000, this.pacing.cooldown) : this.pacing.cooldown;
    if (Date.now() - this.lastTipTime < cooldown) { console.log('[engine] reject: cooldown'); return; }

    const cleaned = agentData.genericizeAbilities(cleanTip(tip));
    if (this.isSimilarToRecent(cleaned)) { console.log('[engine] reject: similar'); this.fillQuietSpell(); return; }

    const topic = topicOf(cleaned);
    const recent = this.tipHistory.slice(-3).map((t) => topicOf(t.text));
    if (recent.length >= 3 && recent.every((t) => t === topic)) { console.log('[engine] reject: topic cooldown'); this.fillQuietSpell(); return; }

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
    const sent = this.emitTip(cleaned, 'ai', { death: !!response.death });
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
    if (this.inLobby) return;   // loading screen / agent select / menu: NO tips, ever, forced or not
    // Beginner tips off: the automatic stream is AI-only. A manual force press
    // is an explicit request for A tip, so its fallback still may answer.
    if (!force && this.experiments().beginnerTips === false) return;
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
    // Library tips inside the death window are the death-flavored bucket, so
    // they wear the same white skull card the AI's death reviews do.
    const inDeathWindow = { death: !!(this.lastDeathAt && Date.now() - this.lastDeathAt < 15000) };
    const agentTip = this.matchContext.agentConfirmed
      ? agentData.getAgentTip(this.matchContext.agent) : null;
    if (agentTip && !recentTexts.includes(agentTip) && !this.isSimilarToRecent(agentTip)
        && Math.random() < 0.22) {
      this.emitTip(agentTip, 'library', inDeathWindow);
      return;
    }

    // A library tip that reads like the tip before it is still a repeat, even
    // in different words: re-roll away from near-duplicates. A manual force
    // press must always answer, so as a last resort it takes the final roll.
    let { text } = tipLibrary.selectTip(this.matchContext, recentTexts);
    for (let i = 0; i < 3 && text && this.isSimilarToRecent(text); i++) {
      recentTexts.push(text);
      ({ text } = tipLibrary.selectTip(this.matchContext, recentTexts));
    }
    if (text && this.isSimilarToRecent(text) && !force) {
      console.log('[engine] library tip suppressed, too close to a recent tip');
      return;
    }
    if (text) this.emitTip(text, 'library', inDeathWindow);
  }

  /** Tracker profile arrived: every subsequent analyze request carries it so
   *  the AI calibrates advice to the player's actual rank and weaknesses. */
  setPlayerStats(stats) {
    this.playerStats = stats && !stats.error ? stats : null;
    if (this.playerStats) console.log('[engine] player stats loaded:', this.playerStats.rank || 'unknown rank');
  }

  /** Coached-session category trends (the dashboard overview): the AI uses
   *  them to favor the weakest or falling category when the frame supports it. */
  setPerformanceSummary(summary) {
    this.perfSummary = summary && typeof summary === 'object' ? summary : null;
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

  /** A rejected tip leaves the same silence a SKIP does. If the quiet spell
   *  has outlasted the pacing budget, cover it with a library tip, the same
   *  treatment SKIP responses already get. */
  fillQuietSpell() {
    if (Date.now() - this.lastTipTime > this.pacing.silence) this.emitLibraryTip();
  }

  /** Frame memory is worth the extra latency when change is the story: the
   *  player just died (explain it), the phase just flipped, or every 3rd
   *  frame as a pattern sample. The rest of the time one fast image wins. */
  shouldSendFrameMemory() {
    if (this.matchContext.lastDeathAt && Date.now() - this.matchContext.lastDeathAt < 15000) return true;
    if (this.recentPhaseTransition()) return true;
    return this.analyzedFrames % 3 === 2;
  }

  /** Observed facts about the player's actual play, deduped and capped.
   *  Unlike tips (advice that was merely SHOWN), these describe what really
   *  happened on screen, so reviews and session grades stay honest. */
  addPlayerNote(note) {
    const n = String(note).trim().slice(0, 90);
    if (!n || n.length < 8) return;
    const lower = n.toLowerCase();
    if (this.playerNotes.some((x) => x.toLowerCase() === lower)) return;
    this.playerNotes.push(n);
    if (this.playerNotes.length > 25) this.playerNotes.shift();
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
  emitTip(text, source, extra) {
    const verified = verifyTip(text, source, this.matchContext);
    if (!verified) { console.log(`[engine] reject(verify/${source}): ${text}`); return false; }

    const tip = { text: verified, source, time: Date.now() };
    if (extra && extra.death) tip.death = true;   // death review: white skull card
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

  /**
   * The anti-repeat gate, three rules from strictest to loosest:
   *   1. VERBATIM: the same sentence (normalized) as any of the last 25 tips
   *      never shows twice, no matter how much time passed. Repeating
   *      important advice is fine, repeating the exact wording is lazy.
   *   2. BACK-TO-BACK: a tip that heavily overlaps the tip right before it
   *      (a light reshuffle of the same sentence) is a repeat at any age.
   *   3. RECENT WINDOW: moderate overlap with anything from the last 60
   *      seconds is a rapid-fire duplicate.
   * A real re-warning later (fresh wording plus "still" / "again" / "third
   * time now" escalation) passes: new words drop it under both thresholds.
   */
  isSimilarToRecent(newTip) {
    const words = tipWords(newTip);
    if (!words.size) return false;
    const norm = normalizeTip(newTip);
    const history = this.tipHistory.slice(-25);
    for (const old of history) {
      if (normalizeTip(old.text) === norm) return true;              // rule 1
    }
    const last = history[history.length - 1];
    if (last && overlapRatio(words, tipWords(last.text)) > 0.75) return true;   // rule 2
    const cutoff = Date.now() - 60000;
    for (const old of history.slice(-10).filter((t) => t.time >= cutoff)) {
      if (overlapRatio(words, tipWords(old.text)) > 0.5) return true;           // rule 3
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
    const prevAlive = this.matchContext.playerAlive;

    // A NEW MATCH in the same session: the round counter falls back to 1 and
    // the score resets to 0-0. Every per-match side lock must reset with it,
    // a first-half side carried over from the previous match is exactly the
    // wrong-side bug. Requires round AND both scores to agree so one misread
    // digit cannot wipe a live match's locks.
    if (typeof updates.roundNumber === 'number' && updates.roundNumber <= 2 && prevRound >= 5
        && typeof updates.teamScore === 'number' && updates.teamScore <= 1
        && typeof updates.enemyScore === 'number' && updates.enemyScore <= 1) {
      console.log(`[engine] new match detected (round ${prevRound} -> ${updates.roundNumber}), side and mode locks reset`);
      this.firstHalfSide = null;
      this.pendingFirstSide = null;
      this.pendingMode = null;
      this.standardEvidence = 0;
      this.swapEvidence = 0;
      this.matchContext.gameMode = null;
      this.matchContext.side = null;   // stale side from the last match: re-read it fresh
    }

    // Game mode from the HUD (agent select header, loading screen, scoreboard,
    // end-of-round banner): two agreeing reads lock it for the match, exactly
    // like the side lock, so one misread frame cannot set the halftime math.
    if (updates.gameMode === 'swiftplay' || updates.gameMode === 'standard') {
      if (!this.matchContext.gameMode) {
        if (this.pendingMode === updates.gameMode) {
          this.matchContext.gameMode = updates.gameMode;
          console.log(`[engine] game mode locked: ${updates.gameMode}`);
        } else {
          this.pendingMode = updates.gameMode;
        }
      }
      delete updates.gameMode;   // never merged raw; only the lock above sets it
    }

    // A single alive:false read can be a flashbang, a smoke, or a misread
    // killcam; the player only counts as dead after TWO consecutive dead
    // reads (or an explicit dead phase). One noisy frame cannot fake a death.
    if (updates.playerAlive === false && updates.phase !== 'dead') {
      this.aliveFalseStreak = (this.aliveFalseStreak || 0) + 1;
      if (this.aliveFalseStreak < 2 && prevAlive !== false) delete updates.playerAlive;
    } else if (updates.playerAlive === true || updates.phase === 'active') {
      this.aliveFalseStreak = 0;
    }

    for (const key of Object.keys(updates)) {
      const v = updates[key];
      if (v === null || v === undefined) continue;
      if (key === 'agent' || key === 'map') {            // locked once set
        if (!this.matchContext[key]) this.matchContext[key] = v;
        continue;
      }
      // handled separately (mode needs its 2-read lock), never merged raw
      if (key === 'recentTopics' || key === 'playerNote' || key === 'gameMode') continue;
      this.matchContext[key] = v;
    }

    if (typeof updates.roundNumber === 'number' && updates.roundNumber > prevRound) {
      this.matchContext.roundsPlayed++;
    }
    // Round-transition awareness: note phase flips (buy -> active -> postplant …)
    // so the next request coaches the NEW phase and the cooldown briefly relaxes.
    if (updates.phase && updates.phase !== prevPhase) {
      this.lastPhaseChange = { from: prevPhase, to: updates.phase, at: Date.now() };
      // A new buy phase means a new plan: drop last round's team read so a
      // stale "4 stacking A" never coaches this round, and drop the player's
      // last known spot, everyone is back at spawn.
      if (updates.phase === 'buy') {
        this.matchContext.teamRead = null;
        this.matchContext.playerSpot = null;
      }
      // The round going live locks the plan into match memory for continuity.
      if (updates.phase === 'active' && prevPhase === 'buy' && this.matchContext.teamRead) {
        this.remember(`Round plan: ${this.matchContext.teamRead}`);
      }
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
    // The alive flag flipping false is a death even when the phase read missed
    // it; open the review window so the death gets explained, not skipped.
    if (updates.playerAlive === false && prevAlive !== false
        && Date.now() - this.lastDeathAt > 20000) {
      this.lastDeathAt = Date.now();
      this.matchContext.lastDeathAt = this.lastDeathAt;
    }

    // Match memory: record round outcomes from score changes so future tips
    // know the flow of the match, not just the current frame.
    const team  = this.matchContext.teamScore  | 0;
    const enemy = this.matchContext.enemyScore | 0;
    if (team > prevTeam)  this.remember(`Won round ${team + enemy} (score ${team}-${enemy})`);
    if (enemy > prevEnemy) {
      this.remember(`Lost round ${team + enemy} (score ${team}-${enemy})`);
      this.lastRoundLostAt = Date.now();   // opens the round-review window
    }

    // ── Halftime math (mode-aware) ─────────────────────────────────────────
    // Vision can misread ATK/DEF, but round numbers are reliable, so once one
    // half's side is known the other half is arithmetic and it OVERRIDES
    // whatever the model claims. The halves depend on the game mode:
    //   swiftplay          4-round halves, first to 5, sudden death round 9
    //   unrated/competitive 12-round halves, overtime from round 25
    // Until the mode is known, only rounds where both modes agree on the half
    // are used (1-4 first half; 10+ can only be a standard match), so a
    // swiftplay's round 5 side swap is never bulldozed by 12-round math.
    const rn = this.matchContext.roundNumber | 0;
    const flipSide = (s) => (s === 'attacking' ? 'defending' : s === 'defending' ? 'attacking' : null);

    // Score/round arithmetic beats every other mode signal: swiftplay ends at
    // 5 round wins and 9 rounds total, so a 6th win or a 10th round proves a
    // standard match. Two consecutive frames of proof are required (a single
    // misread digit cannot lock it), and the proof even overrides a swiftplay
    // lock that came from vision, in which case the side locks reset because
    // they were derived with the wrong half length.
    if (this.matchContext.gameMode !== 'standard'
        && ((this.matchContext.teamScore | 0) >= 6 || (this.matchContext.enemyScore | 0) >= 6 || rn >= 10)) {
      this.standardEvidence++;
      if (this.standardEvidence >= 2) {
        if (this.matchContext.gameMode === 'swiftplay') {
          console.log('[engine] mode corrected to standard (score/round past swiftplay limits), side locks reset');
          this.firstHalfSide = null;
          this.pendingFirstSide = null;
        } else {
          console.log('[engine] game mode locked: standard (score/round past swiftplay limits)');
        }
        this.matchContext.gameMode = 'standard';
      }
    } else {
      this.standardEvidence = 0;
    }

    // Swiftplay tell: with the first-half side locked, two consecutive FRESH
    // HUD reads of the flipped side in rounds 5-8 mean the sides already
    // swapped, which only swiftplay does at that point. (The same side
    // holding needs no lock: trusting the HUD there gives the same answer.)
    const sideRead = typeof updates.side === 'string' ? updates.side : null;
    if (!this.matchContext.gameMode && this.firstHalfSide && sideRead && rn >= 5 && rn <= 8) {
      if (sideRead === flipSide(this.firstHalfSide)) {
        this.swapEvidence++;
        if (this.swapEvidence >= 2) {
          this.matchContext.gameMode = 'swiftplay';
          console.log('[engine] game mode locked: swiftplay (side swap observed in rounds 5-8)');
        }
      } else {
        this.swapEvidence = 0;
      }
    }

    const half = halfOfRound(rn, this.matchContext.gameMode);
    if (half && !this.firstHalfSide && this.matchContext.side) {
      const asFirstHalf = half === 1 ? this.matchContext.side : flipSide(this.matchContext.side);
      if (this.pendingFirstSide === asFirstHalf) {
        this.firstHalfSide = asFirstHalf;
        console.log(`[engine] first-half side locked: ${asFirstHalf}`);
      } else {
        this.pendingFirstSide = asFirstHalf;
      }
    }
    if (half && this.firstHalfSide) {
      const expected = half === 1 ? this.firstHalfSide : flipSide(this.firstHalfSide);
      if (this.matchContext.side !== expected) {
        console.log(`[engine] side corrected by halftime math: round ${rn} -> ${expected} (${this.matchContext.gameMode || 'mode unknown'})`);
        this.matchContext.side = expected;
      }
    }
  }

  async requestMatchReview() {
    try {
      const tips = this.tipHistory.filter((t) => t.source === 'ai').map((t) => t.text);
      const data = await this.callServer(API.MATCH_REVIEW, {
        tips,
        notes: this.playerNotes.slice(-20),   // observed facts ground the review
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
    gameMode: null,   // 'swiftplay' (4-round halves) | 'standard' (12) | null; locked by 2 agreeing reads or score math
    roundNumber: 0, teamScore: 0, enemyScore: 0,
    phase: 'unknown', playerCredits: null, playerWeapon: null, playerAlive: true,
    teammatesAlive: null, enemiesAlive: null,   // reported by the AI from the HUD bar
    teamRead: null,   // pre-round minimap read of the team's plan ("4 A, player alone mid")
    playerSpot: null, // the player's own minimap location ("B main", "mid"), cleared each buy phase
    consecutiveDeaths: 0, consecutiveWins: 0, roundsPlayed: 0,
  };
}

/**
 * Which half a round belongs to, or null when the side must be trusted from
 * the HUD instead of derived:
 *   swiftplay  rounds 1-4 first half, 5-8 second, 9 (sudden death) HUD
 *   standard   rounds 1-12 first half, 13-24 second, 25+ (overtime) HUD
 *   unknown    rounds 1-4 first half (both modes agree), 5-9 ambiguous (a
 *              swiftplay may already have swapped), 10-24 standard halves by
 *              elimination (swiftplay never reaches round 10), 25+ HUD
 */
function halfOfRound(rn, mode) {
  if (rn < 1) return null;
  if (mode === 'swiftplay') return rn <= 4 ? 1 : rn <= 8 ? 2 : null;
  if (mode === 'standard')  return rn <= 12 ? 1 : rn <= 24 ? 2 : null;
  if (rn <= 4) return 1;
  if (rn >= 10 && rn <= 24) return rn <= 12 ? 1 : 2;
  return null;
}

function cleanTip(tip) {
  return tip.replace(/ - /g, ', ').trim();
}

// ── repeat detection primitives ─────────────────────────────────────────────
// Meaningful words only (4+ chars) so overlap measures the advice, not the
// glue words; punctuation is stripped everywhere so "peek," matches "peek"
// and a moved comma is never a disguise.
function tipWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/).filter((w) => w.length > 3));
}
function normalizeTip(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function overlapRatio(aWords, bWords) {
  if (!aWords.size || !bWords.size) return 0;
  let shared = 0;
  for (const w of aWords) if (bWords.has(w)) shared++;
  return shared / Math.min(aWords.size, bWords.size);
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

// Map-specific callouts and where they belong. A tip naming a callout from
// the WRONG map, or any distinctive callout while the map is still unknown,
// is dropped outright: "hold the cross in Hookah" on Ascent is worse than
// silence. Only distinctive names are listed; shared words (mid, heaven,
// main, site) are never gated.
const MAP_CALLOUTS = {
  hookah: ['bind'], showers: ['bind'], lamps: ['bind'],
  catwalk: ['ascent'], market: ['ascent', 'sunset'], tree: ['ascent', 'lotus'],
  garage: ['haven'],
  ropes: ['split'], vents: ['split'], mail: ['split'], sewer: ['split'],
  kitchen: ['icebox'], boiler: ['icebox'], nest: ['icebox'], fridge: ['icebox'],
  pyramids: ['breeze'], cave: ['breeze'],
  dish: ['fracture'], arcade: ['fracture'], canteen: ['fracture'],
  flowers: ['pearl'],
  rubble: ['lotus'], waterfall: ['lotus'],
  boba: ['sunset'],
};
const CALLOUT_RE = new RegExp('\\b(' + Object.keys(MAP_CALLOUTS).join('|') + ')\\b', 'gi');
function wrongMapCallout(text, map) {
  const found = String(text || '').toLowerCase().match(CALLOUT_RE);
  if (!found) return null;
  const m = String(map || '').toLowerCase();
  for (const c of new Set(found)) {
    const homes = MAP_CALLOUTS[c] || [];
    if (!m || !homes.includes(m)) return c;   // unknown map or a foreign callout
  }
  return null;
}

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

  // Map discipline: a callout from another map, or any distinctive callout
  // while the map is unknown, makes the tip wrong by definition.
  if (source !== 'system') {
    const bad = wrongMapCallout(l, ctx.map);
    if (bad) { console.log(`[engine] reject: callout "${bad}" vs map ${ctx.map || 'unknown'}`); return false; }
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
