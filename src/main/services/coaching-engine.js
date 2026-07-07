'use strict';

const EventEmitter = require('events');
const api = require('./api-client');
const tipLibrary = require('./tip-library');
const agentData = require('./agent-data');
const { API, TIMING, PERFORMANCE_INTERVALS, COACHING } = require('../../shared/config');

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
    // Tips the player rated as bad: never re-served from the library, and the
    // most recent ones are sent to the AI so it avoids similar advice.
    this.badTips = new Set(Array.isArray(opts.badTips) ? opts.badTips : []);

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
    this.warnedCapture    = false; // one-time capture-failure notice
    this.lastAuthSuspect  = 0;     // throttle for 401/403 -> license re-check

    this.aiTipCount      = 0;     // coaching-tip mix tracking (AI must stay majority)
    this.libraryTipCount = 0;

    this.enemyHistory  = [];      // recent enemy spots/angles the AI reported
    this.lastWarnedSpot = null;   // de-dupe the "they keep peeking X" warning
    this.recentAbilities = [];    // recent ability words in AI tips (anti-fixation)
    this.lastPhaseChange = null;  // { from, to, at }: round-transition awareness
    this.inLobby        = false;  // server saw a menu/lobby: silence ALL tips
    this.focusIndex     = -1;     // rotates analysis emphasis (map/enemies/eco/…)

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
    this.enemyHistory = [];
    this.lastWarnedSpot = null;
    this.recentAbilities = [];
    this.lastPhaseChange = null;
    this.inLobby = false;
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

      const data = await this.callServer(API.ANALYZE, { image: shot, context: this.buildOutgoingContext() });
      if (this.shouldAbort) return;
      if (!data) { this.onAnalyzeFailed(); return; }
      this.warnedFailure = false;   // server is healthy again
      this.processAIResponse(data);
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
      const data = await this.callServer(API.ANALYZE, { image: shot, context: this.buildOutgoingContext() }, { forced: true });
      if (!data) {
        // Forced press must always produce something useful.
        this.onAnalyzeFailed(true);
        return;
      }
      this.warnedFailure = false;
      if (data.context) this.updateMatchContext(data.context);

      const tip = String(data.tip || '').trim();
      if (tip.length > 10 && tip.toUpperCase() !== 'SKIP') {
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
      const { ok, status, data } = await api.post(path, body, this.licenseKey, undefined, headers);
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
      this.emitTip('Can’t grab the screen, add GhostCoach to your antivirus exclusions and restart coaching.', 'system');
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
    return {
      ...this.matchContext,
      recentTopics,
      recentTips,
      enemyHistory: this.enemyHistory.slice(-6),
      phaseTransition: this.recentPhaseTransition(),
      badTips: [...this.badTips].slice(0, 6),
      agentRole:    agentData.getRole(this.matchContext.agent),
      teammates:    this.matchContext.teammates || null, // passthrough if the server reports the comp
      buyInfoClear: tipLibrary.buyInfoClear(this.matchContext), // don't advise a buy on unclear numbers
      focus:        this.nextFocus(),
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
    // Some frames emphasise the minimap / economy / enemy reads; 'teammates' and
    // 'abilities' nudge the coach to factor in the comp and what's actually usable.
    const foci = ['map', 'enemies', 'economy', 'positioning', 'utility', 'aim', 'teammates', 'abilities'];
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

    const recent  = this.enemyHistory.slice(-3);
    const repeats = recent.filter((s) => s === spot).length;
    if (repeats >= 2 && spot !== this.lastWarnedSpot && Date.now() - this.lastTipTime > 8000) {
      this.lastWarnedSpot = spot;
      this.emitTip(`Heads up, they keep swinging ${prettySpot(spot)}. Pre-aim it or throw util their way.`, 'ai');
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

    if (tip.toUpperCase() === 'SKIP' || tip.length < 20) {         // skip / too short
      this.skipCount++;
      if (this.skipCount >= 2 && Date.now() - this.lastTipTime > TIMING.librarySilence) {
        this.skipCount = 0;
        // The AI has nothing to say and the overlay has been quiet a while:
        // dead air is worse than bending the AI-majority ratio, so let the
        // library speak regardless of the mix.
        this.emitLibraryTip({ ignoreRatio: true });
      }
      return;
    }
    if (TRUNCATION.some((re) => re.test(tip))) { console.log('[engine] reject: truncated'); return; }
    if (!/[.!?"]$/.test(tip))                  { console.log('[engine] reject: incomplete'); return; }
    if (tip.split(/\s+/).length > 24)          { console.log('[engine] reject: too long'); return; }
    // A fresh phase flip (round start, spike planted) opens a short window where
    // a timely tip beats the normal pacing, so the cooldown relaxes to 6s.
    const cooldown = this.recentPhaseTransition() ? 6000 : TIMING.tipCooldown;
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
    if (!force && Date.now() - this.lastTipTime < TIMING.tipCooldown) return;

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
    }
    if (updates.phase === 'active' && prevPhase === 'dead') {
      this.matchContext.consecutiveDeaths = 0;
    }
  }

  async requestMatchReview() {
    try {
      const tips = this.tipHistory.filter((t) => t.source === 'ai').map((t) => t.text);
      const data = await this.callServer(API.MATCH_REVIEW, { tips, context: this.matchContext });
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

// High-confidence situational guards only, never reject on a guess.
function scenarioFits(text, source, ctx) {
  if (!ctx) return true;
  const l = text.toLowerCase();

  // No "analyse the combat report"-style tips, give in-the-moment advice.
  if (source === 'ai' && META_ADVICE.test(l)) return false;

  // Don't tell the player to use an ability their agent can't (e.g. "recon
  // dart" on Reyna). With no confirmed agent, hold back ability-specific tips
  // until we know what they're on, this is the core "verify before tipping".
  if (source === 'ai' && agentData.tipMisusesAbility(text, ctx.agent)) return false;

  // A dead player can only watch / comm, don't tell them to peek or shoot.
  if (ctx.phase === 'dead'
      && /\b(peek|swing|shoot|spray|tap|push|rush|plant|defuse|reload)\b/.test(l)
      && !/\b(comm|call|callout|watch|spectat|info|next round|note)\b/.test(l)) {
    return false;
  }
  // Buy advice only when the round + credits are actually readable (mirrors the
  // library's gating, applied to AI tips that try to talk economy on bad info).
  if (source === 'ai'
      && /\b(buy|eco|force ?buy|full ?buy|half ?buy|credits?)\b/.test(l)
      && !tipLibrary.buyInfoClear(ctx)) {
    return false;
  }
  return true;
}

module.exports = CoachingEngine;
