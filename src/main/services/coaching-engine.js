'use strict';

const EventEmitter = require('events');
const api = require('./api-client');
const tipLibrary = require('./tip-library');
const agentData = require('./agent-data');
const { polishText, cleanTip, tipWords, normalizeTip, overlapRatio, countOf,
        PREAMBLE, TRUNCATION } = require('./tip-hygiene');
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
    this.habits = null;      // recurring mistakes from the week, carried between sessions
    this.perfSummary = null;   // coached-session category trends (dashboard overview)
    // Experimental settings, read live from the store so a settings flip
    // applies to the very next capture: { proPlaybook: 'off'|'on'|'hybrid' }.
    this.experiments = typeof opts.experiments === 'function' ? opts.experiments : () => ({});
    // Death forensics: fresh rolling game-audio clip getter (null when absent).
    this.audioClip = typeof opts.audioClip === 'function' ? opts.audioClip : () => null;
    // Player-written feedback on past tips ({ text, reason }), for the prompt.
    this.getFeedback = typeof opts.getFeedback === 'function' ? opts.getFeedback : () => [];
    // AI decision log: gets { at, image, state, tip, shown } per analyzed frame,
    // for the "what did the coach see and say" viewer. No-op when not provided.
    this.diagnostics = typeof opts.diagnostics === 'function' ? opts.diagnostics : null;

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
    this.aiCreditsOutAt   = 0;     // when the AI last reported out of credits (402), 0 = fine
    this.warnedCapture    = false; // one-time capture-failure notice
    this.lastAuthSuspect  = 0;     // throttle for 401/403 -> license re-check

    this.aiTipCount      = 0;     // coaching-tip mix tracking (AI must stay majority)
    this.libraryTipCount = 0;

    this.enemyHistory  = [];      // recent enemy spots/angles the AI reported
    this.lastWarnedSpot = null;   // de-dupe the "they keep peeking X" warning
    this.recentAbilities = [];    // recent ability words in AI tips (anti-fixation)
    this.recentPlays     = [];    // recent stock plays (crossfire, off-angle...), for variety
    this.lastPhaseChange = null;  // { from, to, at }: round-transition awareness
    this.inLobby        = false;  // server saw a menu/lobby: silence ALL tips
    this.matchMemory    = [];     // running log of the match (rounds, streaks, reads)
    this.playerNotes    = [];     // observed FACTS about what the player did on screen
    this.recentFrames   = [];     // last few REAL gameplay frames (never lobby/desktop)
    this.focusIndex     = -1;     // rotates analysis emphasis (map/enemies/…)
    this.analyzedFrames = 0;      // frames analyzed this session (warm-up gate)
    this.lastDeathAt    = 0;      // when the player last died (death-review window)
    this.deathTipsSent  = 0;      // coaching tips shown since that death (capped, then silence)
    this.lastRoundLostAt = 0;     // when the team last lost a round (round-review window)
    this.aliveFalseStreak = 0;    // consecutive alive:false reads (2 confirm a death)
    this.firstHalfSide    = null; // locked first-half side; halftime flip is then arithmetic
    this.pendingFirstSide = null; // needs two agreeing reads before locking
    this.lockedSide       = null; // sticky side for the window halftime math cannot cover
    this.sideChallenge    = null; // a contradicting side read waiting for a second opinion
    this.pendingMap       = null; // map needs two agreeing reads before locking
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
    this.recentPlays = [];
    this.lastPhaseChange = null;
    this.inLobby = false;
    this.matchMemory = [];
    this.playerNotes = [];
    this.recentFrames = [];
    this.analyzedFrames = 0;
    this.lastDeathAt = 0;
    this.deathTipsSent = 0;
    this.firstHalfSide = null;
    this.pendingFirstSide = null;
    this.lockedSide = null;
    this.sideChallenge = null;
    this.pendingMap = null;
    this.scoreboardChallenge = null;   // pending implausible round/score read
    this.lastScoreAt = 0;              // when a round/score read was last believed, for the rate ceiling
    this.seenLabels = [];              // location labels the game printed, for map fingerprinting
    this.mapConfirmedByLabels = false; // once true, the model cannot change the map
    this.mapDoubt = 0;                 // else a stale doubt keeps blocking callouts
    this.mapChallenger = null;
    this.aliveFalseStreak = 0;
    this.pendingMode = null;
    this.standardEvidence = 0;
    this.swapEvidence = 0;
    // The overlay turns this into its live indicator: the mark, pulsed twice
    // and gone. This used to ALSO emit a welcome tip ("Coach is live. Trust
    // your reads and stay tradeable"), a sentence that is read once, is never
    // useful again, and held one of the four visible card slots for eleven
    // seconds while the player was still loading into the round.
    this.emit('status', 'coaching');

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
    // Out of AI credits: capturing and uploading a screenshot every cycle cannot
    // produce a tip, it just burns the player's CPU and bandwidth. Idle until
    // the cooldown passes, then try once to see if credits are back. Library
    // tips keep flowing throughout, so coaching never goes fully silent.
    if (this.aiCreditsOutAt && Date.now() - this.aiCreditsOutAt < AI_CREDITS_BACKOFF_MS) return;

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
      this._cycleShown = null;                   // reset before this cycle decides
      this.processAIResponse(data);
      if (!this.inLobby) this.pushFrame(shot);   // confirmed gameplay: keep for chat
      // AI decision log: record the frame the coach read, the STATE it parsed
      // from it (its "notes"), the tip it produced, and what was actually shown
      // after the gates. Only for real gameplay, so lobby frames are not logged.
      if (this.diagnostics && !this.inLobby) {
        try {
          this.diagnostics({
            at:    Date.now(),
            image: shot,
            state: data.context || {},
            aiTip: data.tip || '',
            // `death` rides along so the AI log can mark death reviews on the
            // timeline. Without it the log cannot tell a review apart from an
            // ordinary tip, because the text alone is not a reliable tell.
            shown: this._cycleShown
              ? { text: this._cycleShown.text, source: this._cycleShown.source, death: !!this._cycleShown.death }
              : null,
            // Why the model's tip never reached the player. Always read (which
            // also clears it, so a stale reason cannot leak into a later frame).
            // NOT conditional on nothing being shown: a rejected AI tip usually
            // triggers a library tip to fill the gap, so `shown` is set even
            // though the AI's tip was dropped, and that is exactly the case
            // worth explaining.
            reject: takeRejectReason(),
          });
        } catch (e) { console.log('[engine] diagnostics sink error:', e.message); }
      }
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
          const sent = this.emitTip(cleaned, 'ai', { death: !!data.death || this.inDeathWindow() });
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
      // 30s: accuracy-first mode runs a reasoning model on live tips, which can
      // take 15 to 25s. This sits past the server's own 24/26s AI timeout plus
      // network, so a slow reasoning reply is waited out instead of aborted and
      // wrongly read as a failure. The loop is single-in-flight, so a genuinely
      // hung request stalls at most one cycle.
      const { ok, status, data } = await api.post(path, body, this.licenseKey, 30000, headers);
      this.lastServerStatus = status;
      if (!ok) {
        // 402 = the AI account is out of credits. Not transient, so record it
        // and let the loop idle instead of retrying every few seconds.
        if (status === 402) {
          if (!this.aiCreditsOutAt) console.error('[engine] AI out of credits, pausing AI requests');
          this.aiCreditsOutAt = Date.now();
        } else {
          console.error('[engine] server', path, 'status', status);
        }
        return null;
      }
      this.aiCreditsOutAt = 0;   // a success proves credits are back
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
      } else if (this.lastServerStatus === 402) {
        // Out of AI credits. Say so plainly: this is not an app fault and it
        // will not clear on its own, so "temporarily down" would mislead.
        msg = 'The coach AI is out of credits, so AI tips are paused. Library tactics until it’s topped up.';
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
      this.emitTip('Windows blocked screen capture. Add Occlara to your antivirus exclusions (Windows Security, Virus and threat protection, Exclusions), then restart coaching.', 'system');
      if (!force) return;
    }
    this.emitLibraryTip({ force, ignoreRatio: true }); // capture down → ratio doesn't apply
  }

  // ── context sent to the server ───────────────────────────────────────────────
  // Enriches each request with recent round history, the locked agent's role,
  // tracked enemy positions, and a rotating focus hint so a good share of frames
  // emphasise the minimap / economy / enemy reads.
  buildOutgoingContext() {
    this.expireStalePlan();   // never send a plan the team has already abandoned
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
      // THE PLAYS THAT WILL BE REJECTED IF IT USES THEM AGAIN.
      //
      // The engine blocks a play that appeared in either of the last two tips,
      // and it never told the model, which is why a quarter of a real session's
      // calls were spent writing tips that could not possibly be shown: 31 of
      // them said "trade partner" after a trade tip had just gone out, 12 more
      // said hold tight. Naming the blocked plays turns a vague instruction to
      // vary into a constraint the model can actually satisfy.
      // THE THEME THIS SESSION HAS WORN OUT.
      //
      // blockedPlays below only stops back-to-back repeats, and that is not the
      // shape of the problem. Across one real session 9 of the 15 tips a player
      // saw contained the word "alone", none of them adjacent, so every
      // back-to-back rule passed while the session as a whole said one thing
      // over and over. This reports the theme that has taken over the tips the
      // player has ACTUALLY seen, so the model can be told to leave it alone
      // rather than merely to vary its wording.
      overusedTheme: (() => {
        const seen = this.tipHistory.slice(-8).map((t) => String(t.text || ''));
        if (seen.length < 4) return null;
        const THEMES = [
          ['playing alone', /\balone\b|\bsolo\b|\bisolated\b/i],
          ['waiting for a trade', /\btrade\b/i],
          ['holding tight', /hold[^.]*tight|stay tight|tight to/i],
          ['waiting for the team', /wait for|until your team|before you peek/i],
        ];
        for (const [label, re] of THEMES) {
          if (seen.filter((t) => re.test(t)).length / seen.length > 0.5) return label;
        }
        return null;
      })(),
      blockedPlays: this.tipHistory.slice(-2)
        .map((t) => playPatternIn(t.text)).filter(Boolean),
      enemyHistory: this.enemyHistory.slice(-6),
      phaseTransition: this.recentPhaseTransition(),
      badTips: [...this.badTips].slice(0, 6),   // 3-strike blocked tips only
      tipFeedback: (this.getFeedback() || []).slice(-6),
      matchMemory: this.matchMemory.slice(-10),
      playerStats: this.playerStats,
      coachTrend:  this.perfSummary || null,
      habits:      this.habits || null,   // what this player keeps doing wrong   // dashboard category trends
      agentRole:    agentData.getRole(confirmedAgent),
      teammates:    this.matchContext.teammates || null, // passthrough if the server reports the comp
      // Death review: the player died moments ago, the server prompts for a
      // cause-and-fix explanation ONLY when the evidence clearly supports one.
      // The death window closes the moment the player is ALIVE again, not just
      // after 12 seconds. A short round can end and respawn them inside that
      // window, and reviewing a death at someone standing at full health with a
      // fresh round in front of them reads as the coach not watching at all.
      justDied:     this.isSpectating()
                    && this.lastDeathAt > 0 && Date.now() - this.lastDeathAt < 12000,
      // The death review is already done: the coach should stay quiet until the
      // player respawns rather than spend a call on a tip we would drop.
      deathReviewDone: this.isSpectating() && this.deathTipsSent >= DEATH_TIPS_MAX,
      justLostRound: this.lastRoundLostAt > 0 && Date.now() - this.lastRoundLostAt < 12000,
      focus:        this.nextFocus(),
      // Experimental: playbook mode ('off' | 'on' | 'hybrid') for the server.
      proPlaybook:  this.experiments().proPlaybook || 'off',
      // The language the tip should be written in. Read live, so switching it in
      // Settings applies to the very next frame rather than the next session.
      language:     this.experiments().language || 'en',
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

  /** Drop the team plan once it is too old to trust. A buy-phase read describes
   *  the opening push; by the time most of a round has run, the team has often
   *  rotated and coaching "within the plan" actively points the player the wrong
   *  way. Cleared rather than guessed at, so the coach falls back to what it can
   *  actually see. */
  expireStalePlan() {
    const at = this.matchContext.teamReadAt;
    if (!at || !this.matchContext.teamRead) return;
    if (Date.now() - at > TEAM_PLAN_TTL_MS) {
      console.log('[engine] team plan expired (stale), dropping it');
      this.matchContext.teamRead = null;
      this.matchContext.teamReadAt = 0;
    }
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
      noteReject('the model returned raw JSON, not a sentence');
      this.fillQuietSpell();
      return;
    }
    if (PREAMBLE.some((re) => re.test(tip))) {                     // AI preamble
      noteReject('the tip started with AI preamble');
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
    if (TRUNCATION.some((re) => re.test(tip))) { noteReject('the tip was cut off mid sentence'); this.fillQuietSpell(); return; }
    if (!/[.!?"]$/.test(tip))                  { noteReject('the tip did not end as a complete sentence'); this.fillQuietSpell(); return; }
    // A fresh phase flip (round start, spike planted) opens a short window where
    // a timely tip beats the normal pacing, so the cooldown relaxes.
    const cooldown = this.recentPhaseTransition() ? Math.min(6000, this.pacing.cooldown) : this.pacing.cooldown;
    if (Date.now() - this.lastTipTime < cooldown) { noteReject('too soon after the last tip (cooldown)'); return; }

    const cleaned = agentData.genericizeAbilities(cleanTip(tip));
    if (this.isSimilarToRecent(cleaned)) { noteReject('too similar to a recent tip'); this.fillQuietSpell(); return; }

    const topic = topicOf(cleaned);
    const recent = this.tipHistory.slice(-3).map((t) => topicOf(t.text));
    if (recent.length >= 3 && recent.every((t) => t === topic)) { noteReject('same topic as the last three tips'); this.fillQuietSpell(); return; }

    if (!this.validateTipForAgent(cleaned)) {
      noteReject('named an ability the player\'s agent does not have');
      this.emitLibraryTip();   // swap in a solid general tip instead of silence
      return;
    }

    // Anti-fixation on PLAYS, not just abilities. The model leans hard on a few
    // stock recommendations (crossfires above all) and re-serves them with fresh
    // wording on a new site, which slips past both the similarity check and the
    // topic cooldown. A play may not be recommended again while it is still two
    // tips old, so the coaching has to actually vary.
    const play = playPatternIn(cleaned);
    if (play && this.recentPlays.slice(-2).includes(play)) {
      noteReject(`already recommended a ${play} in the last two tips`);
      this.emitLibraryTip();
      return;
    }

    // Anti-fixation: don't suggest the same ability (e.g. Updraft) in back-to-back
    // tips. Forces variety even if the model repeats itself.
    const abilityWord = abilityWordIn(cleaned);
    if (abilityWord && this.recentAbilities.slice(-2).includes(abilityWord)) {
      noteReject('repeated the same ability (' + abilityWord + ') back to back');
      this.emitLibraryTip();
      return;
    }

    this.skipCount = 0;
    const sent = this.emitTip(cleaned, 'ai', { death: !!response.death || this.inDeathWindow() });
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
    const inDeathWindow = { death: this.inDeathWindow() };
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

  /**
   * The mistakes this coach has had to point out across the week.
   *
   * Already computed for the weekly report and never shown to the live coach,
   * so every session started over knowing nothing about the player. A habit is
   * exactly what a coach should carry between games: it is stable, it is about
   * the PLAYER rather than the frame, and it cannot be read off a screenshot.
   * That also makes it safe to send, unlike volatile state, which the model
   * starts answering from instead of reading the picture.
   */
  setHabits(list) {
    this.habits = Array.isArray(list) && list.length ? list.slice(0, 3) : null;
    if (this.habits) {
      console.log('[engine] player habits: '
        + this.habits.map((h) => `${h.label} (${h.sessions} sessions)`).join(', '));
    }
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
    // Dead players get the death review and then SILENCE. Once you are
    // spectating there is nothing left to act on this round, so a stream of
    // tips is just noise over someone watching a killcam. Explain the death
    // (one or two tips), then say nothing until the next buy phase. System
    // notices (license, credits, capture problems) are never suppressed,
    // because those are about the app working at all, not about coaching.
    if (source !== 'system' && this.isSpectating()) {
      if (this.deathTipsSent >= DEATH_TIPS_MAX) {
        noteReject('player is dead, already gave the death review, staying quiet until the next round');
        return false;
      }
    }

    // Every enemy is down: the round is won and there is nothing to act on.
    if (source !== 'system' && this.roundDecided()) {
      noteReject('every enemy is dead, the round is already decided, staying quiet until the next one');
      return false;
    }

    // THE TIP ASSERTS SOMETHING THE HUD ALREADY DISAGREES WITH.
    //
    // Two of these reached a player in one session:
    //   "You are last alive on defense"          with THREE teammates alive
    //   "last alive in a 1v5, use the spike timer" during the BUY PHASE, no spike
    //
    // Both read as confident, specific coaching, and both describe a round that
    // is not happening. This is the same principle as HP beats death: the coach
    // reports what is on screen and never infers, so when a sentence contradicts
    // a number the app has already counted, the number wins.
    if (source === 'ai') {
      const wrong = contradictsState(text, this.matchContext);
      if (wrong) { noteReject(wrong); return false; }
    }

    // Never blame the player for a play this coach just recommended. Checked
    // here rather than inside verifyTip because it needs the tip HISTORY, which
    // is session state rather than frame state.
    if (source === 'ai') {
      const owned = blamesOwnAdvice(text, this.tipHistory.map((t) => t.text));
      if (owned) {
        noteReject(`blamed the player for the "${owned}" play this coach just recommended`);
        return false;
      }
    }

    const verified = verifyTip(text, source, this.matchContext);
    if (!verified) {
      // DO NOT CLOBBER THE REAL REASON. verifyTip records a specific one for
      // most of its refusals (wrong death spot, an ability the agent lacks, a
      // callout from another map, holding while a push lands elsewhere), and
      // this line used to overwrite every one of them with "failed the final
      // verify gate", because noteReject just assigns. A fifth of all rejected
      // tips were logged as unexplained while the explanation had been computed
      // and thrown away one line earlier. The reject reasons are the main tool
      // for diagnosing a session, so this was costing more than it looked.
      if (!lastRejectReason) noteReject(`failed the final verify gate (${source})`);
      return false;
    }

    // Carried to the renderer so the overlay can draw a category glyph without
    // owning a second copy of topicOf(). Those regexes already decide the
    // variety guard, and a drifting duplicate of them in the renderer is
    // exactly the main/preload split that channels.js exists to prevent.
    const tip = { text: verified, source, time: Date.now(), topic: topicOf(verified) };
    if (extra && extra.death) tip.death = true;   // death review: white skull card
    if (source !== 'system') {                       // status notices aren't coaching history
      this.tipHistory.push(tip);
      if (this.tipHistory.length > 50) this.tipHistory.shift();
      if (source === 'ai') this.aiTipCount++;
      else if (source === 'library') this.libraryTipCount++;
    }
    this.lastTipTime = Date.now();
    // Count coaching tips shown while dead, so the review is capped.
    if (source !== 'system' && this.isSpectating()) this.deathTipsSent++;
    // Remember which stock play this tip recommended, whatever its source, so
    // the variety guard sees library filler too and cannot be reset by it.
    if (source !== 'system') {
      const playName = playPatternIn(verified);
      if (playName) {
        this.recentPlays.push(playName);
        if (this.recentPlays.length > 6) this.recentPlays.shift();
      }
    }
    this._cycleShown = tip;   // what got shown this analyze cycle (for the AI log)
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

  /**
   * The map lock, which every callout depends on.
   *
   * This used to be write-once: two agreeing reads locked it, and from then on
   * `if (!this.matchContext.map)` threw away every later read. So one early
   * misread (a loading screen, a dark frame, a model bias toward a common map)
   * locked the WRONG map for the entire match, and it failed in the worst
   * possible direction: the callout gate trusts the lock, so it then actively
   * WAVED THROUGH that map's callouts. A player on Breeze got told to hold
   * "Elbow" and "B Back Site", which are Ascent callouts, and the gate approved
   * because it believed the map was Ascent.
   *
   * Now the lock is revisable. Two agreeing reads still acquire it, and two
   * agreeing CONTRADICTING reads correct it: if the evidence was good enough to
   * set the map, the same weight of evidence is good enough to change it. While
   * a contradiction is pending the map is treated as in doubt, which suppresses
   * named callouts rather than letting the wrong map's callouts through.
   */
  applyMapRead(raw) {
    const v = String(raw || '').trim();
    if (!v) return;
    // Printed location labels already settled this. The model's opinion does not
    // get to overturn evidence the game itself rendered.
    if (this.mapConfirmedByLabels) return;
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

    // Not locked yet: two agreeing reads acquire the lock.
    if (!this.matchContext.map) {
      if (same(this.pendingMap, v)) {
        this.matchContext.map = v;
        this.pendingMap = null;
        this.mapDoubt = 0;
        this.matchContext.mapUncertain = false;
        console.log(`[engine] map locked: ${v}`);
      } else {
        this.pendingMap = v;
      }
      return;
    }

    // Locked and this read agrees: clear any pending doubt.
    if (same(this.matchContext.map, v)) {
      if (this.mapDoubt) console.log(`[engine] map doubt cleared, still ${this.matchContext.map}`);
      this.mapDoubt = 0;
      this.mapChallenger = null;
      this.matchContext.mapUncertain = false;
      return;
    }

    // Locked but this read disagrees. Count consecutive challenges from the
    // SAME challenger; a one-off misread should not unseat a good lock.
    if (same(this.mapChallenger, v)) {
      this.mapDoubt = (this.mapDoubt || 0) + 1;
    } else {
      this.mapChallenger = v;
      this.mapDoubt = 1;
    }

    if (this.mapDoubt >= 2) {
      console.log(`[engine] map corrected: ${this.matchContext.map} -> ${v} (2 agreeing contradictions)`);
      this.matchContext.map = v;
      this.mapDoubt = 0;
      this.mapChallenger = null;
      this.matchContext.mapUncertain = false;
      // Everything derived from the old map is now meaningless.
      this.matchContext.playerSpot = null;
      this.matchContext.playerSpotVerified = false;
      this.matchContext.teamRead = null;
      this.matchContext.enemySpot = null;
      this.remember(`Map corrected to ${v}`);
    } else {
      this.matchContext.mapUncertain = true;
      console.log(`[engine] map in doubt: locked ${this.matchContext.map}, read ${v} (callouts suppressed)`);
    }
  }

  /** True while a contradicting map read is pending, so we do not know which
   *  map's callouts are legal. Named callouts are blocked until it resolves. */
  mapInDoubt() { return (this.mapDoubt || 0) > 0; }

  /**
   * Identify the map from the location labels the game prints beside the
   * minimap. This is the answer to the model being confidently and CONSISTENTLY
   * wrong about the map: a correction rule that waits for it to disagree with
   * itself never fires, but the labels are independent evidence.
   *
   * Each label narrows the candidates ("Mid Top" fits eight maps, adding
   * "B Market" leaves only Sunset). When exactly one map contains every label
   * seen this session, that IS the map, and it overrides whatever the model
   * claims, including a lock the model already won.
   */
  applyLocationLabel(label) {
    const l = String(label || '').trim();
    if (!l) return;
    if (!this.seenLabels) this.seenLabels = [];
    if (!this.seenLabels.includes(l)) this.seenLabels.push(l);
    if (this.seenLabels.length > 12) this.seenLabels.shift();

    const id = mapFromLabels(this.seenLabels);
    if (!id) return;

    if (id.confident && id.map) {
      if (this.matchContext.map !== id.map) {
        console.log(`[engine] map identified from printed labels as ${id.map}`
          + ` (was ${this.matchContext.map || 'unknown'}), labels: ${this.seenLabels.join(', ')}`);
        this.matchContext.map = id.map;
        this.matchContext.playerSpot = null;
        this.matchContext.playerSpotVerified = false;
        this.matchContext.teamRead = null;
      }
      // Printed text is the strongest evidence available, so it also settles
      // any pending doubt outright.
      this.mapDoubt = 0;
      this.mapChallenger = null;
      this.matchContext.mapUncertain = false;
      this.mapConfirmedByLabels = true;
    } else if (!id.candidates.length) {
      // No single map contains all these labels, so one was misread. Drop the
      // oldest and keep going rather than locking onto a contradiction.
      this.seenLabels.shift();
    }
  }

  /** Dead and watching. Either signal counts: the phase read and the alive flag
   *  are kept consistent, but one can land a frame before the other. */
  isSpectating() {
    return this.matchContext.playerAlive === false || this.matchContext.phase === 'dead';
  }

  /**
   * Is this tip a death review? Decided by the CLIENT, not by the model.
   *
   * The server marks reviews with a "DEATH: " prefix, but that instruction only
   * reaches the model when ctx.justDied is already true, and justDied is built
   * from the PREVIOUS frame's state. The death is discovered from the response
   * to the very frame the model is writing the review on, so on that frame the
   * model was never told to add the marker. The result: the actual death review
   * arrives unmarked and renders as an ordinary tip, and by the next frame the
   * review is usually dropped as a duplicate.
   *
   * The player being dead is the fact that matters, and the client already
   * knows it, so it decides. Library tips have always used this window; the AI
   * path now uses the same one, which is why the two used to disagree.
   */
  /**
   * The round is already decided, so there is nothing left to coach.
   *
   * With every enemy dead nobody can punish a mistake, and a tip like "watch
   * the cross while your teammate defuses" is noise over a round that is
   * already won. Coaching resumes on its own next round, because the enemy
   * count comes back up from the HUD read.
   */
  roundDecided() {
    const foes = this.matchContext.enemiesAlive;
    if (foes !== 0) return false;            // unknown, or someone is still alive
    if (this.isSpectating()) return false;   // death silence owns this case already
    // Attacking with the spike still in hand is NOT decided: failing to plant
    // is the one way left to lose, so a plant call still deserves to land.
    const attacking = /attack/i.test(String(this.matchContext.side || ''));
    if (attacking && this.matchContext.spike !== 'planted') return false;
    return true;
  }

  inDeathWindow() {
    // BEING DEAD IS THE WHOLE TEST, and it ends the moment the player respawns.
    //
    // This used to also return true for any tip within 15s of a death, which
    // put the white skull card on tips shown to a player standing at full
    // health in the next buy phase: six of them in one session. A death review
    // aimed at someone who is alive with a fresh round in front of them reads
    // as the coach not watching. buildOutgoingContext's justDied has always
    // closed its window on respawn for exactly this reason; this now matches.
    return this.isSpectating();
  }

  updateMatchContext(updates) {
    const prevPhase = this.matchContext.phase;
    const prevRound = this.matchContext.roundNumber;
    const prevTeam  = this.matchContext.teamScore  | 0;
    const prevEnemy = this.matchContext.enemyScore | 0;
    const prevAlive = this.matchContext.playerAlive;
    const prevSpike = this.matchContext.spike;
    let newMatch = false;   // set by the new-match reset, so the continuity guard stands down

    // A NEW MATCH in the same session: the round counter falls back to 1 and
    // the score resets to 0-0. Every per-match side lock must reset with it,
    // a first-half side carried over from the previous match is exactly the
    // wrong-side bug. Requires round AND both scores to agree so one misread
    // digit cannot wipe a live match's locks.
    if (typeof updates.roundNumber === 'number' && updates.roundNumber <= 2 && prevRound >= 5
        && typeof updates.teamScore === 'number' && updates.teamScore <= 1
        && typeof updates.enemyScore === 'number' && updates.enemyScore <= 1) {
      console.log(`[engine] new match detected (round ${prevRound} -> ${updates.roundNumber}), side/mode/map locks reset`);
      this.firstHalfSide = null;
      this.pendingFirstSide = null;
      this.lockedSide = null;
      this.sideChallenge = null;
      this.pendingMode = null;
      this.standardEvidence = 0;
      this.swapEvidence = 0;
      this.matchContext.gameMode = null;
      this.matchContext.side = null;   // stale side from the last match: re-read it fresh
      this.matchContext.map = null;    // a new match may be a new map: re-read and re-lock
      this.pendingMap = null;
      // The label fingerprint has to go with it. applyMapRead returns early
      // while mapConfirmedByLabels is set, so clearing the map without clearing
      // the confirmation left the new match unable to lock a map at all, and the
      // old match's labels still filtering the candidates.
      this.mapConfirmedByLabels = false;
      this.seenLabels = [];
      this.mapDoubt = 0;
      this.mapChallenger = null;
      this.matchContext.mapUncertain = false;
      this.scoreboardChallenge = null;
      newMatch = true;
    }

    // ── Scoreboard continuity ───────────────────────────────────────────────
    // The round number and score decide the HALFTIME SIDE, so a single misread
    // digit does not just look wrong, it flips the player's side and every tip
    // after it becomes anti-coaching. Observed in a real session: the round read
    // jumped 4 -> 12 -> 4 -> 13, the round-13 read tripped the halftime swap,
    // and an attacking player was coached to set up defensive crossfires for
    // minutes.
    //
    // Those bad reads were internally CONSISTENT (round 13 with a 3-9 score
    // really does add up), so self-consistency alone cannot catch them. What
    // gives them away is continuity: a round can only hold or tick up by one,
    // and scores never fall. An implausible read is held as a challenge and only
    // accepted if the next read agrees, which is the same evidence bar the map
    // lock uses and still lets the app pick up a match it joined late.
    // THE SCOREBOARD IS PRINTED, THE ROUND NUMBER IS NOT.
    //
    // Valorant's HUD shows two scores at the top. It does not show "round 6", so
    // any round number is the model INFERRING one, and it infers badly: across a
    // real session it sat on round 3 while the score climbed 2-1, 2-2, 3-2.
    //
    // That was expensive, because the invariant check below treats a round that
    // disagrees with the scores as an implausible reading and throws away the
    // WHOLE thing, both scores included. So a perfectly good scoreboard read
    // kept being discarded on account of a number the model made up, and the
    // tracked score went as long as 249 seconds without an update, roughly two
    // and a half rounds blind.
    //
    // Valorant's own arithmetic settles it: round = your score + their score + 1.
    // Two separately printed numbers beat one invented one, so the round is now
    // derived whenever both scores are readable, and the checks below run on the
    // corrected value. When the scores are missing there is nothing to derive
    // from and the model's round stands, as before.
    if (typeof updates.teamScore === 'number' && typeof updates.enemyScore === 'number') {
      const derived = updates.teamScore + updates.enemyScore + 1;
      if (updates.roundNumber !== derived) {
        if (typeof updates.roundNumber === 'number') {
          console.log(`[engine] round ${updates.roundNumber} does not match the scoreboard`
            + ` ${updates.teamScore}-${updates.enemyScore}, using round ${derived}`);
        }
        updates.roundNumber = derived;
      }
    }

    if (!newMatch && typeof updates.roundNumber === 'number' && prevRound > 0) {
      const jump = updates.roundNumber - prevRound;
      const scoresFell =
        (typeof updates.teamScore === 'number' && updates.teamScore < prevTeam) ||
        (typeof updates.enemyScore === 'number' && updates.enemyScore < prevEnemy);
      // Valorant's own invariant: round = your score + their score + 1.
      const inconsistent =
        typeof updates.teamScore === 'number' && typeof updates.enemyScore === 'number' &&
        updates.teamScore + updates.enemyScore + 1 !== updates.roundNumber;

      // A round NEVER goes backwards inside a match; only a new match resets it,
      // and that is detected separately above. So a backwards read can never be
      // confirmed, however many times it repeats. Without this, a repeated
      // misread gets accepted and then the true (lower) round walks it back, and
      // the round flaps, which is what drives the halftime side math back and
      // forth mid match.
      const backwards = jump < 0 || scoresFell;

      // TIME IS THE CEILING, AND NO AMOUNT OF AGREEMENT BEATS IT.
      //
      // "Twice in a row: believe it" was too weak on its own. The model reads
      // the SAME wrong HUD on consecutive frames, so agreeing with itself costs
      // it nothing, and a real session walked from round 3 to round 12 in 90
      // seconds and from 1-2 to 2-10 in another 81. Nine rounds cannot happen
      // in ninety seconds: a Valorant round is 100 seconds of play plus a buy
      // phase, so even the fastest possible round cannot repeat under about
      // half a minute.
      //
      // So the clock decides what is possible and the agreement rule only
      // decides what is believable within it. A genuine gap (alt tab, a paused
      // session) still passes, because the allowance grows with real elapsed
      // time rather than with frames.
      const sinceScore = this.lastScoreAt ? (Date.now() - this.lastScoreAt) : 0;
      const roundsPossible = this.lastScoreAt
        ? 1 + Math.floor(sinceScore / MIN_ROUND_MS)
        : Infinity;   // first read of the session has nothing to measure against
      const tooFast = jump > roundsPossible;

      if (backwards) {
        console.log(`[engine] ignoring backwards scoreboard read: round ${prevRound} -> ${updates.roundNumber}`);
        delete updates.roundNumber;
        delete updates.teamScore;
        delete updates.enemyScore;
      } else if (tooFast) {
        // Never confirmable. Repeating an impossible claim does not make it true.
        console.log(`[engine] ignoring impossible scoreboard jump: round ${prevRound} -> ${updates.roundNumber}`
          + ` (+${jump}) after only ${Math.round(sinceScore / 1000)}s, at most +${roundsPossible} was possible`);
        this.scoreboardChallenge = null;
        delete updates.roundNumber;
        delete updates.teamScore;
        delete updates.enemyScore;
      } else if (jump > 1 || inconsistent) {
        const sig = `${updates.roundNumber}|${updates.teamScore}|${updates.enemyScore}`;
        if (this.scoreboardChallenge === sig) {
          // Twice in a row: believe it. Covers a genuinely missed stretch of
          // frames (alt-tab, a long death) rather than a one-off misread.
          console.log(`[engine] scoreboard jump confirmed, accepting round ${updates.roundNumber}`);
          this.scoreboardChallenge = null;
        } else {
          this.scoreboardChallenge = sig;
          console.log(`[engine] implausible scoreboard read ignored: round ${prevRound} -> ${updates.roundNumber}`
            + `, score ${prevTeam}-${prevEnemy} -> ${updates.teamScore}-${updates.enemyScore}`
            + (inconsistent ? ' (does not add up)' : ''));
          delete updates.roundNumber;
          delete updates.teamScore;
          delete updates.enemyScore;
        }
      } else {
        this.scoreboardChallenge = null;   // a clean read clears any pending doubt
      }
      // Stamp the clock whenever a read SURVIVED the guard above. Anything the
      // guard stripped leaves roundNumber deleted, so the allowance keeps
      // growing from the last believed read rather than resetting on a rejection
      // and quietly handing the next bad read a bigger budget.
      if (typeof updates.roundNumber === 'number') this.lastScoreAt = Date.now();
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

    // Death detection. Frames arrive about 12 seconds apart, so demanding two
    // consecutive dead reads (the old rule) meant a death was only believed
    // 12 to 24 seconds after it happened, usually after the round had already
    // moved on, and any single flickered "alive" read reset the wait entirely.
    // That is why deaths went unnoticed.
    //
    // Now the model reports the EVIDENCE for its read. A named dead tell (a
    // spectate label, a killcam, a teammate's name where the player's own
    // loadout belongs) is direct proof, so one frame is enough. Only a bare
    // alive:false with no tell, which is what a flashbang or a dark frame
    // produces, still has to be confirmed by a second frame.
    // A readable health number beats any "dead" read. This is the ground truth
    // and it is what stops a hallucinated spectate tell from silencing the
    // coach for a player who is very much alive.
    if (updates.playerAlive === false && typeof updates.playerHp === 'number' && updates.playerHp > 0) {
      console.log(`[engine] ignoring dead read: health is ${updates.playerHp}`);
      updates.playerAlive = true;
      delete updates.aliveTell;
    }
    if (updates.playerAlive === false && updates.phase !== 'dead') {
      const tell   = String(updates.aliveTell || '');
      // A named tell only counts as proof when the health number was ALSO
      // genuinely absent. In a real session the health went unread on more than
      // half the frames, which left a single hallucinated tell able to declare
      // a death on its own; requiring the corroborating absence keeps the fast
      // path for real deaths (where there is no health to read) and makes a
      // frame the model simply could not parse wait for a second opinion.
      const healthAbsent = updates.playerHp == null || updates.playerHp === 0;
      const proven = healthAbsent && DEAD_TELL.test(tell) && !UNSURE_TELL.test(tell);
      this.aliveFalseStreak = (this.aliveFalseStreak || 0) + 1;
      if (proven) {
        if (this.aliveFalseStreak === 1) console.log(`[engine] death seen on one frame: "${tell}"`);
      } else if (this.aliveFalseStreak < 2 && prevAlive !== false) {
        delete updates.playerAlive;   // unproven, wait for a second read
      }
    } else if (updates.playerAlive === true || updates.phase === 'active') {
      this.aliveFalseStreak = 0;
    }
    if (updates.aliveTell) this.lastAliveTell = String(updates.aliveTell).slice(0, 60);

    // A DEAD PLAYER'S HUD BELONGS TO SOMEBODY ELSE.
    //
    // Valorant puts you on a teammate's camera the moment you die, so the
    // health, the weapon and the position on screen are THEIRS, not the
    // player's. Nothing here knew that, so the spectated teammate's loadout was
    // merged in as the player's own. One real session reported nine different
    // weapons while the player was dead (Operator, Bulldog, Sheriff, Phantom,
    // Vandal, Shorty and more) and the coach then told the player "you died
    // peeking a close angle with the Operator" for a gun they never held.
    //
    // The last values read while the player was actually alive are the true
    // ones, so while spectating these fields are simply not merged. The death
    // review then describes the player's own loadout, which is what it is for.
    const spectatingNow = updates.playerAlive === false || updates.phase === 'dead'
                          || this.isSpectating();
    // playerHp belongs here for the same reason as the rest, and it is the one
    // that mattered most: the server strips a spectated health number before it
    // is ever sent, so the merge below simply skipped the field and the player's
    // LAST-ALIVE health stayed in context. The server then reads
    // `alive || hp > 0` and told the model "THE PLAYER IS ALIVE RIGHT NOW, at
    // 100 HP" while they were watching a killcam, which is precisely the
    // contradiction the whole death pipeline exists to prevent.
    const SPECTATOR_OWNED = ['playerWeapon', 'playerCredits', 'playerSpot', 'mmPos', 'playerHp'];

    for (const key of Object.keys(updates)) {
      const v = updates[key];
      if (v === null || v === undefined) continue;
      if (spectatingNow && SPECTATOR_OWNED.includes(key)) {
        if (this.matchContext[key] !== v) {
          console.log(`[engine] ignoring ${key}="${v}" while spectating (it belongs to the spectated player)`);
        }
        continue;
      }
      if (key === 'agent') {                              // locked once set
        if (!this.matchContext.agent) this.matchContext.agent = v;
        continue;
      }
      // Map locks only after TWO agreeing reads. A single misread (Haven seen
      // as Bind) used to lock for the whole match and let foreign callouts
      // ("go to Hookah" on Haven) pass, since the callout gate trusts the lock.
      // Until it locks, the map stays unknown and every named callout is
      // rejected, so unlocked frames only ever get general directions.
      if (key === 'map') {
        this.applyMapRead(v);
        continue;
      }
      // The location label the GAME printed. Accumulating these fingerprints the
      // map far more reliably than asking the model which map it is on, because
      // the label is text the game rendered rather than the model's judgement.
      if (key === 'locLabel') {
        // The label still identifies the MAP while spectating, because the
        // teammate is on the same map, so fingerprinting always gets it.
        this.applyLocationLabel(v);
        // But it stops being where the PLAYER is the moment they die: it then
        // follows the spectator camera. One session walked A Main, Mid Top, A
        // Tower, A Security, A Link and B Nest while the player lay dead in one
        // spot, and the death reviews named whichever one they happened to land
        // on. Keeping the last label read while alive is what makes "you died
        // at X" true.
        if (!spectatingNow) this.matchContext.locLabel = v;
        continue;
      }
      // handled separately (mode needs its 2-read lock), never merged raw
      if (key === 'recentTopics' || key === 'playerNote' || key === 'gameMode'
          || key === 'aliveTell') continue;
      // The team's plan can CHANGE mid-round (a rotate). A read from the buy
      // phase kept driving tips all round, so the coach would still say "hit B"
      // after the team had rotated to A. Stamp each read, and when the plan
      // actually changes, record it so the coach follows the NEW plan.
      if (key === 'teamRead') {
        const prevRead = this.matchContext.teamRead;
        this.matchContext.teamRead = v;
        this.matchContext.teamReadAt = Date.now();
        if (prevRead && String(prevRead).toLowerCase() !== String(v).toLowerCase()) {
          this.remember(`Team plan changed: ${v}`);
          console.log(`[engine] team plan changed: "${prevRead}" -> "${v}"`);
        }
        continue;
      }
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
        this.matchContext.playerSpotVerified = false;
        // Buy phase means a fresh round: everyone just respawned, so the player
        // is alive by definition. This clears a "dead" state that would
        // otherwise get stuck if the model later reports alive as null (unsure)
        // rather than an explicit true, which used to leave a live player being
        // coached as if they were still spectating. (consecutiveDeaths has its
        // own reset on respawn below, so it is deliberately left alone here.)
        this.matchContext.playerAlive = true;
        this.aliveFalseStreak = 0;
        this.deathTipsSent = 0;   // new round, the coach speaks again
        // Per-round facts: a stale "spike planted" would have the coach
        // coaching a retake for a round that already ended.
        this.matchContext.spike = null;
        this.matchContext.spikeSpot = null;
        this.matchContext.killFeed = null;
      }
      // The round going live locks the plan into match memory for continuity.
      if (updates.phase === 'active' && prevPhase === 'buy' && this.matchContext.teamRead) {
        this.remember(`Round plan: ${this.matchContext.teamRead}`);
      }
    }
    // A death registers from EITHER signal: the phase going to 'dead', or the
    // alive flag flipping false. The phase read misses plenty of deaths, and
    // previously that path only opened the review window without counting the
    // death or recording it, so streaks and match memory quietly lost deaths.
    // Both paths now do the full bookkeeping. Edge-triggered, plus a cooldown
    // so a flapping read cannot log the same death twice.
    const diedByPhase = updates.phase === 'dead' && prevPhase !== 'dead';
    const diedByAlive = updates.playerAlive === false && prevAlive !== false;
    if ((diedByPhase || diedByAlive) && Date.now() - this.lastDeathAt > 20000) {
      this.matchContext.consecutiveDeaths++;
      this.matchContext.consecutiveWins = 0;
      this.lastDeathAt = Date.now();   // opens the death-review window
      this.matchContext.lastDeathAt = this.lastDeathAt;   // visible to the tip verifier
      this.deathTipsSent = 0;          // this death gets its own review budget
      // The health they died with is not health they still have. Leaving it set
      // makes every later frame report a live player to the server, since it
      // treats any positive hp as alive.
      this.matchContext.playerHp = null;
      // WHERE THE PLAYER ACTUALLY DIED, pinned at the moment of death.
      // Everything positional goes stale the instant the spectator camera takes
      // over, so the review has to be told the spot rather than read it off a
      // frame showing a teammate somewhere else entirely. Both fields still
      // hold their last-alive values here, because the spectator guard above
      // stopped merging them.
      this.matchContext.deathSpot =
        this.matchContext.locLabel || this.matchContext.playerSpot || null;
      const where = this.matchContext.deathSpot;
      this.remember(`Player died round ${(this.matchContext.teamScore | 0) + (this.matchContext.enemyScore | 0) + 1}${where ? ` at ${where}` : ''}`);
      if (this.matchContext.consecutiveDeaths >= 2) {
        this.remember(`Player has died ${this.matchContext.consecutiveDeaths} rounds in a row`);
      }
      console.log(`[engine] death registered via ${diedByPhase ? 'phase' : 'alive flag'}`
        + (this.lastAliveTell ? ` ("${this.lastAliveTell}")` : ''));
    }
    // Back alive: a new round started for this player.
    if ((updates.phase === 'active' && prevPhase === 'dead')
        || (updates.playerAlive === true && prevAlive === false)) {
      this.matchContext.consecutiveDeaths = 0;
      this.deathTipsSent = 0;   // coaching resumes now that they can act again
      // The last death's location must not survive into the round after it, or
      // a later tip can cite a spot from a round that already ended.
      this.matchContext.deathSpot = null;
    }
    // A dead player is never in some other phase. Keeping these consistent is
    // what makes the verifier that blocks action advice for dead players fire,
    // since it keys off phase 'dead'.
    if (this.matchContext.playerAlive === false) this.matchContext.phase = 'dead';

    // The spike going down is the single biggest swing in a round, so it goes
    // into memory the moment it is first seen.
    if (updates.spike === 'planted' && prevSpike !== 'planted') {
      const where = updates.spikeSpot || this.matchContext.spikeSpot;
      this.remember(`Spike planted${where ? ' at ' + where : ''}`);
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
      this.sideChallenge = null;   // halftime math is authoritative, drop any pending flip
      return;
    }

    // NO HALFTIME MATH AVAILABLE. halfOfRound() returns null for rounds 5-9
    // while the mode is still unknown, because swiftplay and standard disagree
    // about where the half ends, and standard only locks at a score of 6 or
    // round 10. That left a live window with NO side guard at all, and the
    // model's side read is not stable enough to go unguarded: real sessions
    // show 5 stray "attacking" frames inside 33 "defending" ones in rounds 1-5,
    // which is a read that cannot be true, since sides only swap at halftime.
    //
    // So in that window the side becomes sticky. A flip has to be confirmed by
    // two consecutive agreeing reads before it is accepted, exactly like the
    // scoreboard and map guards. One odd frame can no longer turn the coach
    // around and have it call a defence like an attack.
    if (sideRead && this.lockedSide && sideRead !== this.lockedSide) {
      if (this.sideChallenge === sideRead) {
        console.log(`[engine] side flip confirmed by two reads: ${this.lockedSide} -> ${sideRead}`);
        this.lockedSide = sideRead;
        this.sideChallenge = null;
      } else {
        this.sideChallenge = sideRead;
        this.matchContext.side = this.lockedSide;   // hold the line until corroborated
        console.log(`[engine] side read ${sideRead} contradicts locked ${this.lockedSide}, waiting for a second read`);
      }
    } else if (sideRead) {
      this.lockedSide = sideRead;
      this.sideChallenge = null;
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
    roundNumber: 0, teamScore: 0, enemyScore: 0, clock: null,   // round timer (mm:ss) for stage-aware coaching
    phase: 'unknown', playerCredits: null, playerWeapon: null, playerAlive: true,
    teammatesAlive: null, enemiesAlive: null,   // reported by the AI from the HUD bar
    playerHp: null,   // own health number: the ground truth for being alive
    deathSpot: null,  // where the player died, pinned at death; positional reads go stale once spectating starts
    spike: null,      // 'planted' | 'carried' | 'dropped', drives retake / post-plant coaching
    spikeSpot: null,  // where it is, for the retake call
    killFeed: null,   // last factual event from the kill feed (top right)
    teamRead: null,   // pre-round minimap read of the team's plan ("4 A, player alone mid")
    teamReadAt: 0,    // when that read landed; the plan expires so a rotate is not coached against
    playerSpot: null, // the player's own minimap location ("B main", "mid"), cleared each buy phase
    playerSpotVerified: false, // true when the spot came from minimap coordinates, not the model's wording
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

// cleanTip, tipWords, normalizeTip and overlapRatio now live in tip-hygiene.js.
// They describe how an LLM mangles text, not how Valorant works, so a second
// game gets them for free rather than growing its own copy that drifts.

/**
 * Which subject a tip belongs to. Sent back as recentTopics so the model can
 * see what it has already covered and pick something else.
 *
 * THE ORDER IS THE ALGORITHM, since the first match wins. That is what broke it:
 * "economy" led the list and matched on bare weapon names, so "holding that
 * angle alone with a pistol" was filed as economy advice. Four positioning tips
 * in one session were reported to the model as economy, which told it to stop
 * talking about the buy (it never had) and left it free to repeat the
 * positioning advice it actually had given, four times.
 *
 * So the incidental nouns are gone from economy, which now needs real economy
 * words, and the behaviour categories are tested first because they describe
 * what the tip is ASKING FOR rather than what it happens to mention.
 */
function topicOf(text) {
  const l = (text || '').toLowerCase();
  if (/spike|plant|defus|retake|post.plant/.test(l)) return 'spike';
  if (/flash|smoke|drone|molly|util|wall|dash|ability/.test(l)) return 'utility';
  if (/crosshair|head height|spray|tap|strafe|\baim/.test(l)) return 'aim';
  if (/peek|wide|jiggle|swing|reposition|off.angle/.test(l)) return 'peeking';
  // The single most common shape of advice this coach gives, and until now it
  // had no name at all, so every instance was filed under whatever noun it
  // happened to contain.
  if (/stay (tight|low|back)|hold (tight|that angle|the angle|your angle)|tight to|behind (the |that |your )?(wall|corner|cover|box|ledge|crate)|exposed/.test(l)) return 'positioning';
  if (/rotate|rotation|lurk|minimap|flank/.test(l)) return 'rotation';
  if (/team|trade|comm|callout|group|alone|solo/.test(l)) return 'teamwork';
  if (/\b(buy|buying|credits?|eco|force.?buy|full buy|half.?buy|save (this|the) round|save for)\b/.test(l)) return 'economy';
  if (/tilt|mental|focus|breath|calm/.test(l)) return 'mental';
  if (/dead|died|death|spectat/.test(l)) return 'death';
  return 'general';
}

// PREAMBLE and TRUNCATION moved to tip-hygiene.js: both describe how a model
// truncates or pads a reply, which is not a Valorant fact.

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

// countOf moved to tip-hygiene.js alongside the balanced-punctuation check that
// is its only caller.

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
  // Everything that is wrong with a tip REGARDLESS of the game (shouting, a
  // dropped noun, a sentence cut off mid clause, model preamble) is handled in
  // tip-hygiene.js, so a second game inherits it instead of rediscovering it.
  // What remains below is the part that needs to know Valorant.
  const t = polishText(rawText, source);
  if (t === null) return null;

  const words = t.split(/\s+/);

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

// Defense in depth for the ability guard (the prompt is the primary fix): a tip
// that COMMANDS using a specific mobility ability the player may have already
// spent ("use your dash to reposition", "satchel out and rotate"). We cannot
// verify cooldown state, and the frame is seconds old, so these gamble on an
// ability that may be gone. The GOAL is fine ("reposition after the kill"); it
// is the "use your <ability>" command we drop, since the coach should teach the
// action, not a button that might be on cooldown.
const ABILITY_COMMAND = new RegExp(
  '\\b(?:use|pop|hit|blow|throw|activate)\\s+(?:your\\s+)?'
  + '(dash(?:es)?|updraft|tailwind|satchel|blast pack|high gear|sprint|blink|gatecrash)\\b', 'i');

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
// The fastest a Valorant round can possibly repeat: a 30 second buy phase plus
// the shortest survivable round. Real rounds average well over a minute, so
// this is already generous, and it needs to be: too loose and a run of rejected
// reads banks enough time for the bad value to walk in anyway, which is exactly
// what 30 seconds did when replayed against the session that prompted this.
const MIN_ROUND_MS = 40000;

// How many coaching tips a player gets after dying. Enough to explain the death
// and the fix; past that they are spectating and cannot act on anything, so the
// coach goes quiet until they respawn.
const DEATH_TIPS_MAX = 2;

// How long the engine stops sending frames after the AI reports it is out of
// credits. Long enough that an outage costs almost nothing, short enough that
// topping up resumes coaching on its own without a restart.
const AI_CREDITS_BACKOFF_MS = 3 * 60 * 1000;

// How long a pre-round team plan stays trustworthy once the round is live. A
// round is 1:40, so a plan from the buy phase describes the opening push; past
// this the team has usually rotated and the plan misleads more than it helps.
const TEAM_PLAN_TTL_MS = 45000;

// Evidence that the player is genuinely dead and spectating, as reported in the
// model's aliveTell. Any one of these is direct proof, so the death registers
// from a single frame instead of waiting ~12s for a second one to agree.
const DEAD_TELL = /spectat|kill ?cam|death ?recap|observer|you died|respawn|teammate'?s? (?:name|loadout)|no hp|grey(?:ed)?[- ]?out/i;
// A read the model itself was not sure about never counts as proof.
const UNSURE_TELL = /unreadable|kept previous|unclear|not sure|cannot tell|can.?t tell|assum/i;

// Advice that requires living teammates: impossible in a solo clutch
// (teammatesAlive reported as 0 by the AI from the HUD portraits).
const TEAM_PLAY_TIP = /\btrad(?:e|es|ed|ing)\b|\bteammates?\b|\bcrossfire\b|\bswing (?:with|together)\b|\bas five\b|\bregroup\b|\btrade partner\b|\bentry with\b/i;

// Map-specific callouts and where they belong. A tip naming a callout from
// the WRONG map, or any distinctive callout while the map is still unknown,
// is dropped outright: "hold the cross in Hookah" on Ascent is worse than
// silence. Only distinctive names are listed; shared words (mid, heaven,
// main, site) are never gated.
// Distinctive callout -> the standard 5v5 map(s) it belongs to, generated from
// the game's own region data (valorant-api.com) by `npm run sync:valorant`, so
// a callout maps to EVERY map that has it and the gate only rejects it when it
// is truly foreign, and it stays current when a new map ships. A small fallback
// covers the (never-in-practice) case of the generated file being absent.
const MAP_CALLOUTS = (() => {
  try {
    const c = require('../../shared/valorant-data.generated.json').mapCallouts;
    if (c && Object.keys(c).length) return c;
  } catch (e) { console.error('[engine] generated callouts missing, using fallback:', e.message); }
  return { hookah: ['bind'], showers: ['bind'], lamps: ['bind'], kitchen: ['icebox'],
    garage: ['haven', 'split', 'icebox'], pyramids: ['breeze'], dish: ['fracture'],
    tree: ['ascent', 'fracture', 'lotus'], flowers: ['pearl'], waterfall: ['lotus'] };
})();
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

/** Distinct callout words named in a tip, lowercased. */
function namedCallouts(text) {
  const found = String(text || '').toLowerCase().match(CALLOUT_RE);
  return found ? [...new Set(found)] : [];
}

// FULL location names ("a sewer", "c link", "mid window"), built from the real
// per map callout lists. CALLOUT_RE above cannot be reused here: it holds only
// the 34 DISTINCTIVE words (hookah, boba, snowman) that identify a map, and
// deliberately excludes the structural ones (link, window, site, long) that
// make up most actual callouts. Matching by pattern instead, something like
// "(a|b|c|mid) <word>", would catch every "a free kill" and "a crossfire" in
// the language, so the names come from the data.
const SPOT_RE = (() => {
  try {
    const geo = require('../../shared/valorant-data.generated.json').mapGeometry || {};
    const names = new Set();
    for (const g of Object.values(geo)) {
      for (const c of (g.callouts || [])) if (c && c.n) names.add(String(c.n).toLowerCase());
    }
    if (!names.size) return null;
    // Longest first, so "b boat house" wins over a nested shorter name.
    const alts = [...names].sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('\\b(' + alts.join('|') + ')\\b', 'gi');
  } catch { return null; }
})();

/** Full location names a tip mentions, lowercased. */
function namedSpots(text) {
  if (!SPOT_RE) return [];
  const found = String(text || '').toLowerCase().match(SPOT_RE);
  return found ? [...new Set(found.map((s) => s.trim()))] : [];
}

// A tip that explains a death. Matched on the text rather than a flag, because
// verifyTip is the last gate and runs on library tips and rescued text too,
// where no flag was ever attached. Deliberately narrow: it must be about the
// PLAYER dying, so "trade your teammate when they die" is not caught.
const DEATH_REVIEW_RE = /\byou (died|got (killed|traded|picked)|were (killed|traded|caught)|lost that (duel|fight))\b|\byour death\b|\bthat death\b/i;

// A tip ASSERTING the player is not alive right now, which is a claim about the
// world that the health number can settle. Split from DEATH_REVIEW_RE because
// that one asks "is this reviewing a death" while this asks "is this telling the
// player they are dead", and the second is checkable against the HUD.
//
// "you are spectating" belongs here: it is the same false claim wearing
// different words, and it was shown to a player at full health.
const CLAIMS_DEAD_RE = /\byou (died|are dead|were killed|got killed|got traded|got picked|were traded|were caught)\b|\byou'?re dead\b/i;
const CLAIMS_SPECTATING_RE = /\byou (are|'?re) (spectating|watching (a|your) (teammate|killcam))\b|\byou are in the killcam\b/i;

/** What the tip claims about the player's state, or null if it claims nothing. */
function claimsNotAlive(text) {
  const t = String(text || '');
  if (CLAIMS_DEAD_RE.test(t)) return 'dead';
  if (CLAIMS_SPECTATING_RE.test(t)) return 'spectating';
  return null;
}

function isDeathReview(text, ctx) {
  if (!ctx) return false;
  // While the player is DEAD every location on screen is the spectated
  // teammate's, and the player cannot act on any of them, so any location a tip
  // names is either about their death or is meaningless. Gate regardless of
  // wording: the tips that drifted worst ("You pushed into C Link alone") never
  // contained the phrase "you died" at all, so keying off that phrase missed
  // exactly the cases this exists to catch.
  if (ctx.playerAlive === false || ctx.phase === 'dead') return true;
  // Just respawned: only gate text that is actually reviewing the death, so a
  // live tip about the round now is free to name wherever it needs to.
  return !!(ctx.lastDeathAt && Date.now() - ctx.lastDeathAt < DEATH_WINDOW_MS
    && DEATH_REVIEW_RE.test(String(text || '')));
}

// Advice that parks the player where they are. Deliberately narrow: only
// phrasings that mean "stay put", never "rotate", "fall back" or "push", which
// are the correct answers to a push and must survive.
const HOLD_ADVICE = /\b(hold|holding|anchor|stay|sit|post up|lock down|watch)\b/i;
const MOVE_ADVICE = /\b(rotate|rotating|fall back|retreat|collapse|reposition|push|move to|head to|get to|go to|leave)\b/i;

/**
 * The tip tells the player to hold their ground while a confirmed push is
 * landing on a different site.
 *
 * Requires ALL of: a live push (question marks are a lean, not a fact), the
 * enemies already inside the site (still in lobby is a look, not a commit),
 * the push at a site the player is NOT at, and hold-shaped advice with no
 * movement in it. Anything less and the tip is allowed, because silencing a
 * round wrongly is worse than an imperfect tip.
 *
 * @returns {{where:string}|null}
 */
function wrongSideHold(text, ctx) {
  if (!ctx || !ctx.pushSite || ctx.pushLive !== true || ctx.pushOnSite !== true) return null;
  if (!/defend/i.test(String(ctx.side || ''))) return null;

  const where = String(ctx.locLabel || ctx.playerSpot || '');
  const playerSite = (where.match(/^\s*(A|B|C|Mid)\b/i) || [])[1];
  if (!playerSite) return null;                                   // cannot tell where they are
  if (playerSite.toUpperCase() === String(ctx.pushSite).toUpperCase()) return null;  // their own fight

  const t = String(text || '');
  if (!HOLD_ADVICE.test(t)) return null;
  if (MOVE_ADVICE.test(t)) return null;   // it does tell them to move, let it through
  return { where };
}

/**
 * The tip names places, but not the one the player actually died at.
 *
 * At least ONE named spot has to be the death spot, rather than every named
 * spot having to be it. A review legitimately mentions other places, "you died
 * in Mid Window while your team was stacking C Lobby" is a good tip and the
 * strict version threw it away. What must never happen is a tip that talks
 * about locations without the real one among them, which is how "pushed into C
 * Link" reached a player who died at A Sewer.
 */
function wrongDeathSpot(text, deathSpot) {
  const spots = namedSpots(text);
  if (!spots.length) return null;                 // no location claimed, fine
  const truth = String(deathSpot || '').trim().toLowerCase();
  if (!truth) return spots[0];                    // nothing captured: cannot verify any of them
  return spots.includes(truth) ? null : spots[0];
}

// The reason the most recent tip was dropped. The console line alone is not
// enough: the AI decision log needs to SHOW why a tip the model produced never
// reached the player, otherwise a filtered tip looks identical to no tip.
let lastRejectReason = null;
function noteReject(reason) {
  lastRejectReason = reason;
  console.log('[engine] reject: ' + reason);
}
function takeRejectReason() {
  const r = lastRejectReason;
  lastRejectReason = null;
  return r;
}

// Which maps contain a given printed location label. Built from the game's own
// callout data, so it stays correct as maps are added or renamed.
const MAP_LABEL_INDEX = (() => {
  try {
    const geo = require('../../shared/valorant-data.generated.json').mapGeometry || {};
    const idx = {};
    for (const [map, g] of Object.entries(geo)) {
      const names = new Set();
      for (const c of g.callouts) {
        names.add(c.n.toLowerCase());
        if (c.a) names.add(String(c.a).toLowerCase());
      }
      idx[map] = names;
    }
    return idx;
  } catch (e) {
    console.log('[engine] map label index unavailable:', e.message);
    return {};
  }
})();

/**
 * A printed label as the index stores it.
 *
 * The model sometimes qualifies what the game prints, "B Site (Attacker Side)"
 * for "B Site". The qualifier is commentary, not part of the name, and keeping
 * it turns a perfectly good label into an unknown one.
 */
function normaliseLabel(l) {
  return String(l || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Narrow the map by intersecting every printed label seen so far.
 *
 * ONE UNKNOWN LABEL USED TO DISABLE THIS FOR THE ENTIRE SESSION. The test was
 * that EVERY label seen so far belongs to the candidate map, so a single name
 * the index did not carry ("Fountain", which is a real Bind callout the game
 * data does not list) emptied the candidate set and it never refilled. No error,
 * no log line: the map lock, and the callout gate that depends on it, simply
 * stopped existing, which is the failure this guard was written to prevent.
 *
 * It survived a long time because it needs a model that phrases labels slightly
 * differently to trigger it. Across three sessions on the previous model there
 * was not one unrecognised label; the first session on a new one produced two in
 * the first four frames and the map never locked again.
 *
 * A label no map has ever printed cannot tell two maps apart, so it is now
 * ignored rather than allowed to poison the set. The strictness that matters is
 * kept exactly as it was: every label that IS recognised must still agree on one
 * map, so a real callout from the wrong map still blocks the lock.
 */
function mapsWithLabel(l) {
  const hits = [];
  for (const [map, names] of Object.entries(MAP_LABEL_INDEX)) {
    // The game prints "B Fountain"; a model reasonably writes "Fountain". Accept
    // the bare name when the site letter is the only thing missing, otherwise a
    // map-exclusive callout is thrown away as unrecognised.
    if (names.has(l) || names.has(`a ${l}`) || names.has(`b ${l}`) || names.has(`c ${l}`)) hits.push(map);
  }
  return hits;
}

/**
 * Narrow the map by intersecting the printed labels seen so far, then, if that
 * is inconclusive, by weighing them.
 *
 * NOT ALL LABELS ARE WORTH THE SAME, and treating them as equal is what broke
 * this. "B Long" exists on exactly one map, so seeing it IS the answer. "A Site"
 * exists on all thirteen and carries no information whatsoever. Under a plain
 * intersection a single wrong generic label ("B Main", real, on nine maps, not
 * one of them Bind) silently vetoes a label that identified the map outright,
 * and the lock never engages for the rest of the session.
 *
 * So a label now counts for 1/(number of maps that have it): exclusive callouts
 * dominate, generic ones barely register, and one misread cannot cancel real
 * evidence. Locking still demands a lot, because a WRONG lock is worse than
 * none: the model can no longer correct it, and the callout gate starts
 * rejecting valid callouts. It needs a full exclusive-label's worth of evidence
 * and to beat the runner up by double.
 */
const LABEL_EVIDENCE_MIN = 1.0;    // one map-exclusive label, or several near-exclusive ones
const LABEL_EVIDENCE_EDGE = 2;     // and it must be twice the next best map
// ...AND enough labels to be worth weighing at all. Weighing exists to stop one
// bad label vetoing good ones, which only makes sense once there are good ones
// to protect. On two or three labels a single wrong-but-real callout can carry
// the vote outright, and a real 3-frame sample did exactly that, locking Haven
// on a Bind session. Below this the strict path still locks whenever the labels
// genuinely agree, so clean evidence is never held back; only the contested case
// has to wait, which is the case that needs the evidence.
const LABEL_VOTE_MIN = 4;

function mapFromLabels(labels) {
  const seen = [...new Set((labels || []).map(normaliseLabel).filter(Boolean))];
  if (!seen.length) return null;
  const known = seen.map((l) => [l, mapsWithLabel(l)]).filter(([, m]) => m.length);
  if (!known.length) return { map: null, confident: false, candidates: [] };

  const title = (n) => n.charAt(0).toUpperCase() + n.slice(1);

  // Clean agreement: every recognised label fits one map and only one. This is
  // the original rule and it still decides the common case.
  const candidates = Object.keys(MAP_LABEL_INDEX)
    .filter((map) => known.every(([, maps]) => maps.includes(map)));
  if (candidates.length === 1) {
    return { map: title(candidates[0]), confident: true, candidates };
  }

  // Contradictory labels. Weigh them by how much each one actually narrows the
  // map rather than letting the weakest veto the strongest, but only once there
  // is enough of them that the weighing means something.
  if (known.length < LABEL_VOTE_MIN) return { map: null, confident: false, candidates };
  const score = new Map();
  for (const [, maps] of known) {
    const w = 1 / maps.length;
    for (const m of maps) score.set(m, (score.get(m) || 0) + w);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0] || [null, 0];
  const runnerUp = ranked[1] ? ranked[1][1] : 0;
  if (best && bestScore >= LABEL_EVIDENCE_MIN && bestScore >= runnerUp * LABEL_EVIDENCE_EDGE) {
    return { map: title(best), confident: true, candidates: [best] };
  }
  return { map: null, confident: false, candidates };
}

// The stock plays the model reaches for over and over. Naming them lets the
// engine stop the same recommendation being re-served in fresh wording, which
// is what made every other tip a crossfire in a real session.
const PLAY_PATTERNS = [
  ['crossfire',  /\bcross ?fire\b/i],
  ['off-angle',  /\boff.?angle\b/i],
  ['fall-back',  /\bfall back\b|\bplay for the retake\b|\bback to site\b/i],
  ['group-up',   /\bgroup (?:up|with)\b|\bstick with your team\b|\bwith your teammates?\b|\bstay (?:with|near) the group\b/i],
  ['reposition', /\breposition\b|\bdo not (?:re)?hold the same\b|\bmove after (?:the|your) kill\b/i],
  ['trade',      /\btrade (?:your|the|them)\b|\btrade partner\b/i],
  // THE ADVICE THIS COACH ACTUALLY REPEATS, which had no entry here at all.
  // Measured on a real session: 14 of 23 tips the player saw were some version
  // of "stay tight and wait for your team", two of them almost word for word,
  // and 10 of 11 were invisible to this list. The guard was working perfectly on
  // the plays the model rarely reaches for while its favourite went uncounted.
  ['hold-tight', /\b(?:stay|hold|sit|keep)\s+(?:tight|low|back)\b|\btight (?:to|against|behind)\b|\bhold (?:that|the|your) angle\b/i],
  ['wait-out',   /\bwait for (?:your |the )?(?:team|teammates|entry|them)\b|\buntil (?:your |the )?team (?:clears|commits|arrives)\b|\bbefore you peek out\b|\bwait for them to clear\b/i],
];
function playPatternIn(text) {
  const t = String(text || '');
  for (const [name, re] of PLAY_PATTERNS) if (re.test(t)) return name;
  return null;
}

/**
 * The coach blaming the player for a play it just told them to make.
 *
 * From a real session, twenty seconds apart:
 *   SHOWN  "You have the dash ready, so take an aggressive off-angle on B Main
 *           to catch their defuse attempt."
 *   THEN   "You died to Viper because you took an aggressive off-angle on B
 *           Main alone without a teammate to trade the kill."
 *
 * The player did exactly what they were told, it did not work, and the coach
 * turned round and called it their mistake. Nothing destroys trust faster, and
 * no amount of prompt wording reliably prevents it, because from the model's
 * point of view each sentence is independently true.
 *
 * Narrow on purpose. It only fires on a DEATH REVIEW that faults the same PLAY
 * the coach recommended in its last two tips. A review of something the coach
 * never suggested is honest coaching and passes untouched, and so does advice
 * that merely repeats a play without blaming anyone.
 *
 * @returns the play name when the tip contradicts recent advice, else null
 */
// Claims the tip can make that the app has already COUNTED, so a disagreement
// is a fact-check rather than a matter of taste.
const CLAIMS_LAST_ALIVE = /\blast alive\b|\b1v[2-9]\b|\bclutch(ing)?\b|\ball your teammates are dead\b|\byou are alone against\b/i;
const CLAIMS_SPIKE_DOWN = /\bspike timer\b|\bspike is (down|planted)\b|\bpost.?plant\b|\bthe defuse\b|\bdefusing\b/i;

/**
 * Does this tip contradict something the HUD read already established?
 *
 * Every rule here fired on a real tip that reached a real player. The failure
 * is not that the advice is bad, it is that the advice is about a round that is
 * not happening, which is far more corrosive: it is specific, confident and
 * checkable, so the player knows immediately that the coach is not watching.
 *
 * Only ever rejects on a POSITIVE contradiction. A missing count means the app
 * does not know, and not knowing is never grounds for throwing away a tip.
 *
 * @returns a reject reason, or null when nothing conflicts
 */
function contradictsState(text, ctx) {
  const t = String(text || '');
  if (!ctx) return null;

  // "Last alive" is a count, and the app has the count.
  if (CLAIMS_LAST_ALIVE.test(t)
      && typeof ctx.teammatesAlive === 'number' && ctx.teammatesAlive > 0) {
    return `said the player was last alive while ${ctx.teammatesAlive} teammates were still up`;
  }

  // A clutch cannot happen during the buy phase: nobody has died yet. This is
  // usually a stale count carried over from the end of the previous round, and
  // it produced "last alive in a 1v5" to a player at full health in buy.
  if (CLAIMS_LAST_ALIVE.test(t) && ctx.phase === 'buy') {
    return 'described a clutch during the buy phase, where nobody has died yet';
  }

  // The spike drives a whole family of advice, so referencing it when it is not
  // down sends the player to defuse something that does not exist.
  if (CLAIMS_SPIKE_DOWN.test(t) && ctx.phase === 'buy') {
    return 'referenced the spike during the buy phase, before it can be planted';
  }

  // Telling a living player they are dead. Health is the ground truth for being
  // alive, so this is the same kind of fact-check as "last alive" with four
  // teammates still up.
  //
  // DELIBERATELY NARROW, because the last guard built on this idea did real
  // damage. Deaths that looked fabricated turned out to be genuine (see
  // test-alive-claims), and suppressing their reviews silenced correct coaching
  // at the exact moment it mattered most. So a claim is only rejected when the
  // player is AFFIRMATIVELY alive and there is no death under review: dead by
  // either signal, or a death recent enough that reviewing it is still the right
  // thing to do, both leave the tip alone.
  const notAlive = claimsNotAlive(t);
  if (notAlive) {
    const aliveNow = ctx.playerAlive === true
      || (typeof ctx.playerHp === 'number' && ctx.playerHp > 0);
    const reviewing = ctx.playerAlive === false || ctx.phase === 'dead'
      || !!(ctx.lastDeathAt && Date.now() - ctx.lastDeathAt < DEATH_WINDOW_MS);
    if (aliveNow && !reviewing) {
      const at = typeof ctx.playerHp === 'number' ? ` at ${ctx.playerHp} HP` : '';
      return notAlive === 'spectating'
        ? `said the player was spectating while they were alive${at} and playing the round`
        : `said the player was dead while they were alive${at}`;
    }
  }

  return null;
}

function blamesOwnAdvice(text, tipHistory) {
  const t = String(text || '');
  if (!DEATH_REVIEW_RE.test(t)) return null;   // only a review assigns fault
  const play = playPatternIn(t);
  if (!play) return null;
  const recent = (tipHistory || []).slice(-2);
  for (const prev of recent) {
    const prevText = typeof prev === 'string' ? prev : (prev && prev.text) || '';
    // The coach's own advice, not an earlier review of the same mistake.
    if (DEATH_REVIEW_RE.test(prevText)) continue;
    if (playPatternIn(prevText) === play) return play;
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
  // Don't command a mobility ability we can't confirm is off cooldown.
  if (source !== 'system' && ABILITY_COMMAND.test(l)) {
    noteReject('told the player to use an ability we cannot confirm is off cooldown');
    return false;
  }
  if (source !== 'system' && PROMPT_LEAK.test(text)) return false;
  // Solo clutch: nobody is alive to trade or crossfire with, so team-play
  // advice is impossible and gets dropped no matter how good it sounds.
  if (ctx.playerAlive !== false && ctx.teammatesAlive === 0 && TEAM_PLAY_TIP.test(l)) {
    return false;
  }

  // Map discipline: a callout from another map, or any distinctive callout
  // while the map is unknown, makes the tip wrong by definition.
  if (source !== 'system') {
    // A contradicting map read is pending, so we do not know which map's
    // callouts are legal. Block them all rather than trust a lock that may be
    // about to be corrected: this is the exact failure that put Ascent
    // callouts ("Elbow", "B Back Site") in front of a player on Breeze.
    if (ctx.mapUncertain) {
      const anyCallout = String(text || '').toLowerCase().match(CALLOUT_RE);
      if (anyCallout) {
        noteReject(`named "${anyCallout[0]}" while the map read is in doubt`);
        return false;
      }
    }
    const bad = wrongMapCallout(l, ctx.map);
    if (bad) { noteReject(`used the callout "${bad}" which does not belong to ${ctx.map || 'the unknown map'}`); return false; }

    // DEATH LOCATION GATE. Telling the prompt where the player died is not
    // enough on its own: measured over one real session, reviews named the
    // right spot 7 times and the wrong one 8, either drifting to whatever the
    // spectator camera was showing (pinned A Sewer, tip said C Link) or
    // inventing a place when no spot had been captured at all.
    //
    // So the client decides, the same way it already decides the map. A review
    // may name the spot the player actually died at and nothing else; if no
    // spot was captured it may name no location at all. Rejecting is the right
    // outcome rather than rewriting, because the sentence is built around the
    // place and a substitution would leave the reasoning describing somewhere
    // the player never was.
    // HOLDING A DEAD ANGLE WHILE THEY HIT SOMEWHERE ELSE.
    //
    // With a live push confirmed on site at a DIFFERENT site from the player,
    // a tip telling them to sit still is the worst one available: it keeps
    // them out of a round that is already happening without them. The prompt
    // covers this, but "hold your angle" is the single most common shape of
    // advice in the whole library, so the model reaches for it constantly and
    // a rule it can overlook is not enough.
    const stuck = wrongSideHold(l, ctx);
    if (stuck) {
      noteReject(`told the player to hold ${stuck.where} while ${ctx.pushCount} enemies are confirmed on ${ctx.pushSite}`);
      return false;
    }

    // NOTE, AND DO NOT REINTRODUCE THIS.
    //
    // A guard used to live here rejecting any tip that said "you died" while the
    // health number was above zero, on the reasoning that HP beats death. It was
    // removed because the premise is false at exactly the moment it matters: the
    // instant a player dies the HUD starts showing the SPECTATED teammate's
    // health in the same place, so "hp 100" is routine while genuinely dead.
    //
    // The guard therefore suppressed real death reviews, which is the opposite
    // of its intent, and it looked like it was working because the tips it threw
    // away did read like hallucinations. Two sessions of correct coaching were
    // misfiled as fabrication before anyone opened the screenshots.
    //
    // The contradiction is now settled server side, where the evidence lives:
    // when the model's own aliveTell says it is looking at a spectator HUD, the
    // tell wins and the health number is dropped. See SPECTATE_TELL in
    // server/routes/coach.js.

    if (isDeathReview(l, ctx)) {
      const wrongSpot = wrongDeathSpot(l, ctx.deathSpot);
      if (wrongSpot) {
        noteReject(ctx.deathSpot
          ? `said the death was at "${wrongSpot}" but the player died at "${ctx.deathSpot}"`
          : `named "${wrongSpot}" as the death spot, but no death location was captured`);
        return false;
      }
    }
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
// Exposed for tests. The death-location gate is the kind of rule that is easy
// to get subtly wrong (gating a general tip, or letting the spectated location
// through), so it is checked directly rather than only through a live session.
module.exports.__test = { contradictsState, blamesOwnAdvice, isDeathReview, wrongDeathSpot, namedCallouts, namedSpots, wrongSideHold, mapFromLabels, claimsNotAlive, verifyTip };
