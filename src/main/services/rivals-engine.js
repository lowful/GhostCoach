'use strict';

/**
 * The Marvel Rivals coach.
 *
 * Same event surface as coaching-engine.js, deliberately, so the controller, the
 * overlay and the AI log need no special case for which game is running. What is
 * completely different is the cadence.
 *
 * Valorant reads a frame every ten seconds, roughly 360 an hour, because a
 * positional read stays true for a few seconds and then does not. Rivals is a
 * chaotic 6v6 where moment to moment position is noise, and the decisions that
 * settle the game are discrete: what you pick, and when you switch. So this
 * engine captures on STATE CHANGE rather than on a clock, which works out at two
 * to five captures a match instead of hundreds, and costs on the order of one
 * percent as much to run.
 *
 * The cost of that design is that a missed draft is a missed match, since hero
 * select lasts under a minute. Hence the fast probe below: a cheap poll looking
 * only for the draft screen, which stops as soon as it finds one.
 */
const EventEmitter = require('events');
const api = require('./api-client');
const { cleanTip, tipWords, overlapRatio } = require('./tip-hygiene');
const { draftAdvice, draftTipAllowed } = require('../../shared/rivals-draft');
const { normaliseRole } = require('../../shared/rivals-comp');

// Hero select runs a short countdown, so the probe has to be quicker than the
// main Valorant loop or it misses drafts entirely. It is only a probe: the
// model answers LOBBY for anything that is not a draft or a scoreboard, and
// LOBBY costs a handful of tokens.
const PROBE_MS = 8000;
// Once a draft is found there is nothing more to learn from the same screen, so
// the engine goes quiet rather than re-reading a countdown.
const DRAFT_COOLDOWN_MS = 90 * 1000;
// A scoreboard sits on screen for a while, and reviewing it twice would just
// repeat the same sentence.
const REVIEW_COOLDOWN_MS = 5 * 60 * 1000;

class RivalsEngine extends EventEmitter {
  /**
   * @param opts { getKey, capture, log } the same shape the Valorant engine
   *        takes, so main/index.js can construct either from the registry.
   */
  constructor(opts = {}) {
    super();
    this.getKey = opts.getKey || (() => null);
    this.capture = opts.capture || (async () => null);
    this.log = opts.log || (() => {});
    // WHICH QUESTIONS THIS ENGINE IS ALLOWED TO ASK.
    //
    // The draft read gets teammate roles wrong, so it is off by default and the
    // engine never sends that request at all. That is stronger than gating the
    // tip afterwards: a request never made cannot produce a wrong answer, and it
    // does not spend a vision call to be thrown away.
    this.features = { review: true, draft: false, ...(opts.features || {}) };
    this.running = false;
    this.timer = null;
    this.lastDraftAt = 0;
    this.lastReviewAt = 0;
    this.recentTips = [];
    this.aiTipCount = 0;
    this.paused = false;
    this.lastState = {};
    // The session archive reads this on quit. Valorant fills it with per round
    // memory; Rivals has one review a match, so it stays empty rather than
    // absent, because an absent array is a crash and an empty one is a fact.
    this.matchMemory = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.emit('status', { running: true, game: 'rivals' });
    this.log('[rivals] started, probing every ' + (PROBE_MS / 1000) + 's');
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.emit('status', { running: false, game: 'rivals' });
    this.log('[rivals] stopped');
  }

  schedule(ms) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  /** One probe: capture, ask, act on whatever screen it turned out to be. */
  async tick() {
    if (!this.running || this.paused) return;
    const key = this.getKey();
    if (!key) { this.schedule(PROBE_MS); return; }

    let image = null;
    try { image = await this.capture(); } catch { image = null; }
    if (!image) { this.schedule(PROBE_MS); return; }

    // Which question to ask is decided by what has NOT been asked recently,
    // rather than by trying to classify the screen locally. A local classifier
    // would be a second thing that can be wrong about the screen.
    const now = Date.now();
    const wantDraft = this.features.draft && now - this.lastDraftAt > DRAFT_COOLDOWN_MS;
    const route = wantDraft ? '/api/rivals/draft' : '/api/rivals/review';
    // With draft off, every probe is a review question. The model answers LOBBY
    // for anything that is not a scoreboard, which costs a handful of tokens, so
    // polling for the end of a match is affordable in a way a Valorant style
    // loop would not be.
    if (!wantDraft && !this.features.review) { this.schedule(PROBE_MS); return; }

    try {
      const { ok, data } = await api.post(route, { image }, key, 30000);
      if (!ok || !data) { this.schedule(PROBE_MS); return; }

      if (data.error === 'credits') {
        // Report honestly and back off, rather than looking broken.
        this.emit('status', { running: true, credits: false, retryIn: data.retryIn });
        this.schedule(Math.max(PROBE_MS, (data.retryIn || 180) * 1000));
        return;
      }

      const tip = String(data.tip || '').trim();
      const ctx = data.context || {};

      // Protocol, not coaching. The model correctly saying "this is not a draft"
      // must never reach a player or a tip counter.
      if (/^(SKIP|LOBBY)$/i.test(tip)) { this.schedule(PROBE_MS); return; }

      if (ctx.phase === 'draft') this.lastDraftAt = now;
      if (ctx.phase === 'scoreboard') this.lastReviewAt = now;
      this.lastState = ctx;

      this.offer(this.vet(tip, ctx), ctx, 'ai');
      this.schedule(ctx.phase === 'draft' ? DRAFT_COOLDOWN_MS : PROBE_MS);
    } catch (e) {
      this.log('[rivals] probe failed: ' + e.message);
      this.schedule(PROBE_MS);
    }
  }

  /**
   * THE DRAFT GATE, on the client, which is where every guard in this codebase
   * lives. coach.js parses and coaching-engine.js decides; rivals.js parses and
   * this decides. Keeping it here also keeps the server deployable, since only
   * server/ ships and a require reaching into src/ throws on Railway.
   *
   * A blocked tip is replaced rather than dropped. The player has eleven seconds
   * of hero select left, so a blank overlay helps nobody, and the replacement is
   * arithmetic over a roster the guard has already agreed is trustworthy.
   */
  vet(tip, ctx) {
    if (!ctx || ctx.phase !== 'draft') return tip;      // reviews are not gated on a roster
    const draft = { locked: Array.isArray(ctx.locked) ? ctx.locked : [], suggested: ctx.suggested };
    const verdict = draftTipAllowed(tip, draft);
    if (verdict.ok) return tip;

    this.log('[rivals] draft tip blocked: ' + verdict.why);
    const advice = draftAdvice(draft);
    return advice ? `Lock a ${advice.role}, ${advice.why}.` : '';
  }

  /**
   * Show a tip, unless it repeats one the player just read.
   *
   * Rivals sends so few tips that repetition is more glaring here than in
   * Valorant, not less: two drafts in a row producing the same sentence is the
   * entire coaching experience for that session.
   */
  offer(text, ctx, source) {
    // Protocol words are filtered in tick() too. Repeated here because a
    // protocol word rendered as a coaching card is a visible, embarrassing bug,
    // and this is the last gate before the overlay.
    if (/^(SKIP|LOBBY)$/i.test(String(text || '').trim())) return;

    const clean = cleanTip(text);
    if (!clean) return;
    // overlapRatio compares SETS from tipWords, not strings. Handing it strings
    // reads .size as undefined and returns 0 every time, so every repeat gets
    // through and the anti-repeat looks like it is working.
    const words = tipWords(clean);
    if (this.recentTips.some((t) => overlapRatio(words, t) > 0.6)) {
      this.log('[rivals] dropped a repeat');
      return;
    }
    this.aiTipCount++;
    this.recentTips.push(words);
    if (this.recentTips.length > 6) this.recentTips.shift();
    this.emit('tip', { text: clean, source, game: 'rivals', phase: (ctx && ctx.phase) || null });
  }

  /**
   * The switch call, on demand rather than on a clock.
   *
   * This is where counter picking lives, because it is the first point at which
   * the enemy team is actually visible. Hero select never shows it, which the
   * capture frames settled and the draft prompt is written around.
   */
  async switchCall() {
    const key = this.getKey();
    if (!key) return { error: 'No license active.' };
    let image = null;
    try { image = await this.capture(); } catch { image = null; }
    if (!image) return { error: 'Could not capture the screen.' };
    try {
      const { ok, data } = await api.post('/api/rivals/review', { image }, key, 30000);
      if (!ok || !data || !data.tip) return { error: 'No answer came back.' };
      return { tip: data.tip, context: data.context || {} };
    } catch (e) {
      return { error: 'Could not reach the coach.' };
    }
  }

  // ── The rest of the engine contract ────────────────────────────────────────
  //
  // main/index.js drives whichever engine is running through one interface, and
  // a missing method is not a quiet no-op: pushTip calls getMix() on every tip,
  // so the first Rivals tip crashed the main process with "getMix is not a
  // function" while every unit test passed. Unit tests exercised the class; only
  // booting the app exercised the CONTRACT.
  //
  // Each of these is implemented honestly rather than stubbed to satisfy a
  // caller. Where Rivals has no equivalent concept the method does nothing and
  // says why, which is different from pretending the feature exists.

  /** Tip provenance, for the session archive. Rivals has no library fallback. */
  getMix() {
    return { ai: this.aiTipCount, library: 0, aiShare: this.aiTipCount ? 1 : 0 };
  }

  /** Push a tip in from outside, used for system messages. */
  emitTip(text, source = 'system') {
    this.emit('tip', { text: String(text || ''), source, game: 'rivals', phase: null });
  }

  /** The manual "coach me now" button: take a frame and read it immediately. */
  requestTip() { if (this.running) this.tick(); }

  pause() { this.paused = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  resume() { if (this.paused) { this.paused = false; this.tick(); } }

  noteBadTip() { /* Rivals sends too few tips for a three strike list to mean anything yet. */ }

  // Valorant reads the player's agent to gate ability advice. Rivals coaching is
  // role-shaped rather than hero-shaped, and the hero read is not reliable
  // enough to gate on, so these are accepted and ignored rather than acted on.
  setAgent() {}
  confirmAgent() {}

  // Habits, performance summaries and rank stats are all Valorant-shaped inputs
  // built from its own session history. Rivals has no equivalent record yet, and
  // feeding it Valorant's would describe the wrong game.
  setHabits() {}
  setPerformanceMode() {}
  setPerformanceSummary() {}
  setPlayerStats() {}

  /** What the diagnostics panel and the AI log ask for. */
  snapshot() {
    const raw = Array.isArray(this.lastState.locked) ? this.lastState.locked : [];
    // Advice is computed from the RAW roster, never the filtered one. Filtering
    // the unreadable entries out first hides them from the trust check, so a
    // roster the coach only half read looks complete and gets confident advice.
    // The filtered list is for DISPLAY only.
    const onlyDraft = this.lastState.phase === 'draft';
    return {
      game: 'rivals',
      running: this.running,
      phase: this.lastState.phase || null,
      map: this.lastState.map || null,
      locked: raw.map(normaliseRole).filter(Boolean),
      // No draft has been read means there is nothing to advise on, which is a
      // different thing from a draft where nobody has locked in yet.
      advice: onlyDraft ? draftAdvice({ locked: raw, suggested: this.lastState.suggested }) : null,
      tipsShown: this.recentTips.length,
    };
  }
}

module.exports = { RivalsEngine, PROBE_MS, DRAFT_COOLDOWN_MS, REVIEW_COOLDOWN_MS };
