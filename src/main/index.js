'use strict';

const { app, globalShortcut } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Distinct app identity (GhostCoach 2.0) ───────────────────────────────────
// MUST run before electron-store / the logger are required below, so config and
// debug.log live in their own %APPDATA%\GhostCoach 2.0 folder and never mix with
// the original GhostCoach install's data. Same machine = same deviceId, so the
// license just needs activating once in this build.
app.setName('GhostCoach 2.0');
app.setPath('userData', path.join(app.getPath('appData'), 'GhostCoach 2.0'));

const logger   = require('./logger');
const store    = require('./services/store');
const capture  = require('./services/capture');
const CoachingEngine = require('./services/coaching-engine');
const registry = require('./windows/registry');
const overlayWindow    = require('./windows/overlay-window');
const panelWindow      = require('./windows/panel-window');
const settingsWindow   = require('./windows/settings-window');
const historyWindow    = require('./windows/history-window');
const statsWindow      = require('./windows/stats-window');
const dockWindow       = require('./windows/dock-window');
const activationWindow = require('./windows/activation-window');
const onboardingWindow = require('./windows/onboarding-window');
const chatWindow       = require('./windows/chat-window');
const api              = require('./services/api-client');
const tray     = require('./tray');
const hotkeys  = require('./hotkeys');
const registerIpc = require('./ipc/register-ipc');
const licenseService = require('./services/license-service');
const agentData = require('./services/agent-data');
const C = require('../shared/channels');

// ── Session state ────────────────────────────────────────────────────────────
const state = {
  isCoaching: false,
  isPaused:   false,
  status:     'idle',   // idle | coaching | paused | stopped
  tips:       [],       // recent tips this session (newest first)
  agent:      { agent: null, confirmed: false, role: null }, // detected/confirmed agent
  tipRatings: store.get('tipRatings') || {},   // text -> 'good'|'bad', disk-backed so ratings survive restarts and mark archived sessions
  licenseActive: true,  // false once the subscription ends (locks coaching)
  licenseReason: '',    // why it ended (expired | cancelled | payment_failed | ...)
};

let mainLaunched = false;

function buildState() {
  return {
    isCoaching: state.isCoaching,
    isPaused:   state.isPaused,
    status:     state.status,
    game:       'Valorant',
    tips:       state.tips.slice(0, 50),
    tipCount:   state.tips.length,
    tipMix:     engine ? engine.getMix() : { ai: 0, library: 0, aiShare: 0 },
    agent:      state.agent,
    tipRatings: state.tipRatings,
    licenseActive: state.licenseActive,
    licenseReason: state.licenseReason,
    tipPosition:     store.get('tipPosition'),
    tipScale:        store.get('tipScale'),
    showTips:        store.get('showTips'),
    overlayPosition: store.get('overlayPosition'),
    performanceMode: store.get('performanceMode'),
    licensePlan:     store.get('licensePlan'),
    licenseStatus:   store.get('licenseStatus'),
    licenseExpiry:   store.get('licenseExpiry'),
  };
}

function pushTip(tip) {
  const full = { text: tip.text, source: tip.source || 'system', time: tip.time || Date.now() };
  state.tips.unshift(full);
  if (state.tips.length > 50) state.tips.pop();
  registry.broadcast(C.PUSH_TIP, full);
  registry.broadcast(C.PUSH_STATE, buildState());
}

function setStatus(status) {
  state.status = status;
  registry.broadcast(C.PUSH_STATUS, { status });
  registry.broadcast(C.PUSH_STATE, buildState());
  tray.update(state.isCoaching, trayActions);
}

// ── Coaching controller ──────────────────────────────────────────────────────
// Owns the CoachingEngine instance and forwards its events onto the IPC bus.
let engine = null;

const controller = {
  start() {
    if (state.isCoaching) return;
    if (!state.licenseActive) {
      // Subscription ended: refuse to coach, remind the user, and re-check in
      // case they just renewed.
      pushTip({ text: 'Your subscription has ended. Renew in Settings to start coaching.', source: 'system' });
      revalidateNow();
      return;
    }

    engine = new CoachingEngine({
      licenseKey:      store.get('licenseKey'),
      // Read the quality setting at capture time so a settings change applies live.
      captureFunction: () => capture.captureScreenshot(store.get('captureQuality')),
      performanceMode: store.get('performanceMode'),
      badTips:         store.get('badTips'),
      // Experimental settings, read live so flipping them in Settings applies
      // to the very next capture without restarting the session.
      experiments: () => ({ proPlaybook: playbookMode() }),
    });
    engine.on('tip',    (tip) => pushTip(tip));
    engine.on('status', (status) => {
      state.isPaused = status === 'paused';
      setStatus(status);
    });
    engine.on('match-review', async (review) => {
      const data = { review, game: 'Valorant', timestamp: Date.now(), tipsCount: state.tips.length };
      // Stat movement vs the previous match: compact chips on the review card.
      try {
        const current = await fetchTrackerStats(true);
        if (current) {
          data.statsDelta = { current, prev: store.get('lastMatchStats') || null };
          store.set('lastMatchStats', { ...current, _at: Date.now() });
        }
      } catch {}
      // The actual match from the tracker: result, KDA, ACS, ADR, and a grade.
      try {
        const lm = await fetchLastMatch();
        if (lm) data.lastMatch = lm;
      } catch {}
      registry.broadcast(C.PUSH_MATCH_REVIEW, data);
      saveMatchSummary(data);
      // Natural moment to go deeper: nudge toward the Ask Coach chat.
      pushTip({ text: 'Want the full breakdown? Open Ask Coach from the panel and ask what to fix.', source: 'system' });
      // Riot publishes match data a few minutes after the match ends; if it
      // was not up yet, try once more and re-push the review with real stats.
      if (!data.lastMatch) {
        setTimeout(async () => {
          try {
            const lm = await fetchLastMatch();
            if (lm) registry.broadcast(C.PUSH_MATCH_REVIEW, { ...data, lastMatch: lm });
          } catch {}
        }, 90000);
      }
    });
    engine.on('agent', (info) => {
      state.agent = info || { agent: null, confirmed: false, role: null };
      registry.broadcast(C.PUSH_AGENT, state.agent);
      registry.broadcast(C.PUSH_STATE, buildState());
    });
    // The server rejected our license key (401/403), confirm with an immediate
    // re-validation so a genuinely ended subscription locks fast (and a transient
    // server error does not, since revalidate is authoritative).
    engine.on('auth-suspect', () => revalidateNow());

    state.isCoaching = true;
    state.isPaused   = false;
    state.agent      = { agent: null, confirmed: false, role: null };
    state.tips       = [];   // fresh session; the previous one is archived on stop
    engine.start();
    if (state.pendingAgent) {           // player typed their agent before starting
      engine.setAgent(state.pendingAgent);
      state.pendingAgent = null;
    }
    // Pull a FRESH tracker profile in the background for every session (force
    // bypasses the cache): the last match just changed the numbers, and once
    // it lands every analyze request calibrates to the up-to-date player.
    fetchTrackerStats(true).then((s) => { if (engine && s) engine.setPlayerStats(s); }).catch(() => {});
    setStatus('coaching');
    console.log('[coach] started');
  },
  stop() {
    if (!state.isCoaching) return;
    state.isCoaching = false;
    state.isPaused   = false;
    // Score the session for the stats dashboard (server AI grades the four
    // categories from the tips; result logged locally, fire and forget).
    if (engine) {
      logSessionPerformance(
        state.tips.filter((t) => t.source === 'ai' || t.source === 'library').map((t) => t.text),
        { map: engine.matchContext.map, agent: engine.matchContext.agent },
      );
    }
    // Archive the session before tearing the engine down (mix + memory live there).
    saveSessionArchive(engine ? {
      tipMix: engine.getMix(),
      matchMemory: engine.matchMemory.slice(),
    } : {});
    if (engine) { engine.stop(); engine = null; }
    state.agent = { agent: null, confirmed: false, role: null };
    registry.broadcast(C.PUSH_AGENT, state.agent); // hide the panel bubble/chip
    setStatus('stopped');
    console.log('[coach] stopped');
  },
  pauseResume() {
    if (!state.isCoaching || !engine) return;
    if (state.isPaused) { engine.resume(); engine.requestTip(); }
    else                { engine.pause(); }
    // state.isPaused + status pushes are driven by the engine 'status' event.
  },
  async forceTip() {
    if (engine) await engine.requestTip();
  },
  confirmAgent() { if (engine) engine.confirmAgent(); },
  resizePanel(h) { if (typeof h === 'number') panelWindow.setContentHeight(h); },
  setAgent(name) {
    if (engine) return engine.setAgent(name);
    // Not coaching yet: remember the choice and apply it when the engine starts,
    // so typing an agent never bounces with a confusing "not found".
    const canonical = agentData.resolveName(name);
    if (!canonical) return { ok: false, error: 'unknown agent' };
    state.pendingAgent = canonical;
    state.agent = { agent: canonical, confirmed: true, role: agentData.getRole(canonical) };
    registry.broadcast(C.PUSH_AGENT, state.agent);
    return { ok: true, ...state.agent };
  },
  getState() { return buildState(); },
  listSessions() { return listSessions(); },
  getSession(file) { return getSession(file); },
  toggleOverlay() { overlayWindow.toggleVisible(); },
  setOverlayInteractive(on) { overlayWindow.setInteractive(!!on); },
  toggleMinimizePanel() {
    const willMinimize = !panelWindow.isMinimized();
    if (willMinimize) {
      const anchor = panelWindow.getDockAnchor(dockWindow.SIZE); // capture before hiding
      panelWindow.setMinimized(true);
      dockWindow.showAt(anchor);
    } else {
      dockWindow.hide();
      panelWindow.setMinimized(false);
    }
    tray.update(state.isCoaching, trayActions);
    return panelWindow.isMinimized();
  },
  openSettings()  { settingsWindow.open(); },
  openHistory()   { historyWindow.open(); },
  openChat()      { chatWindow.open(); },
  openStats()     { statsWindow.open(); },

  /** "Ask Coach about this" from the stats dashboard: stash the session's
   *  context, then open chat; the chat window collects the seed via CHAT_SEED
   *  and auto-sends it as the opening question. */
  openChatSeeded(seed) {
    if (seed && typeof seed === 'object') {
      const n = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
      state.chatSeed = {
        date:       String(seed.date || '').slice(0, 40),
        map:        seed.map ? String(seed.map).slice(0, 24) : null,
        overall:    n(seed.overall),
        scores:     seed.scores && typeof seed.scores === 'object' ? {
          economy: n(seed.scores.economy), positioning: n(seed.scores.positioning),
          utility: n(seed.scores.utility), aim: n(seed.scores.aim),
        } : null,
        strengths:  String(seed.strengths  || '').slice(0, 400),
        weaknesses: String(seed.weaknesses || '').slice(0, 400),
      };
    }
    chatWindow.open();
  },
  takeChatSeed() {
    const s = state.chatSeed || null;
    state.chatSeed = null;
    return s;
  },

  /** The assembled extended-stats dashboard: category trends from the local
   *  performance log, rank/win-rate from the tracker profile, and the recent
   *  match list (server-cached 15 min, client-cached alongside). */
  async getStatsDashboard() {
    const perf   = loadPerf();            // oldest -> newest
    const recent = perf.slice(-10);
    const prev   = perf.slice(-20, -10);
    const avg = (rows, k) => rows.length
      ? Math.round(rows.reduce((s, r) => s + ((r.scores && r.scores[k]) || 0), 0) / rows.length)
      : null;
    const categories = {};
    for (const k of ['economy', 'positioning', 'utility', 'aim']) {
      const a = avg(recent, k);
      categories[k] = { avg: a, direction: prev.length ? trendDirection(a, avg(prev, k)) : 'flat' };
    }

    const stats     = store.get('playerStats') || null;
    const prevStats = store.get('lastMatchStats') || null;
    const rank = {
      value: (stats && stats.rank) || null,
      direction: stats && prevStats ? trendDirection(rankIndex(stats.rank), rankIndex(prevStats.rank), 0) : 'flat',
    };
    const winRate = {
      value: stats && stats.winRate != null ? stats.winRate : null,
      direction: stats && prevStats ? trendDirection(stats.winRate, prevStats.winRate) : 'flat',
    };

    return {
      categories, rank, winRate,
      sessions: perf.slice(-15).reverse(),   // newest first for the list
      sessionCount: perf.length,
      matches: await this.getMatches(false),
      riotConnected: (store.get('riotId') || '').includes('#'),
    };
  },

  /** Recent tracker matches with ratings. manual=true is the refresh button:
   *  rate limited to once per 3 minutes, otherwise the cache serves. */
  async getMatches(manual) {
    const riotId = (store.get('riotId') || '').trim();
    if (!riotId.includes('#')) return { matches: [], fetchedAt: 0, error: 'no-riot-id' };
    const now = Date.now();
    if (manual && now - matchesClient.lastManual < 3 * 60 * 1000) {
      return { matches: matchesClient.data || [], fetchedAt: matchesClient.fetchedAt,
               refreshBlockedFor: 3 * 60 * 1000 - (now - matchesClient.lastManual) };
    }
    if (!manual && matchesClient.data && now - matchesClient.fetchedAt < 15 * 60 * 1000) {
      return { matches: matchesClient.data, fetchedAt: matchesClient.fetchedAt };
    }
    try {
      const { ok, data } = await api.get('/api/coach/matches?username=' + encodeURIComponent(riotId)
        + (manual ? '&refresh=1' : ''), store.get('licenseKey'), 20000);
      if (ok && data && Array.isArray(data.matches)) {
        matchesClient = { data: data.matches, fetchedAt: data.fetchedAt || now,
                          lastManual: manual ? now : matchesClient.lastManual };
        return { matches: data.matches, fetchedAt: matchesClient.fetchedAt };
      }
      return { matches: matchesClient.data || [], fetchedAt: matchesClient.fetchedAt,
               error: (data && data.error) || 'unavailable' };
    } catch {
      return { matches: matchesClient.data || [], fetchedAt: matchesClient.fetchedAt, error: 'network' };
    }
  },

  /** Ask Coach: one conversation turn. Text-only: the coach works from the
   *  session's tips, match memory, and tracker stats, no screenshots. With no
   *  session played yet the AI is told not to invent gameplay observations. */
  async chat(messages) {
    const licenseKey = store.get('licenseKey');
    if (!licenseKey) return { ok: false, error: 'No license active.' };

    const hasSessionData = state.tips.length > 0 || listSessions().length > 0;
    const context = {
      agent:        state.agent && state.agent.agent,
      sessionTips:  state.tips.slice(0, 20).map((t) => t.text),
      matchMemory:  engine ? engine.matchMemory.slice(-8) : [],
      stats:        await fetchTrackerStats(),
      noSessionYet: !hasSessionData,
      proPlaybook:  playbookMode(),   // experimental: curated habits in chat
    };
    try {
      const { ok, data } = await api.post('/api/coach/chat', { messages, context }, licenseKey, 30000);
      if (ok && data && data.reply) return { ok: true, reply: data.reply };
      return { ok: false, error: (data && data.error) || 'The coach had no answer. Try again.' };
    } catch (e) {
      console.error('[chat] failed:', e.message);
      return { ok: false, error: 'Could not reach the coach server.' };
    }
  },

  /** Settings "Connect" button: test the tracker link right now, and if it
   *  works, push the stats into the running engine + chat immediately. */
  async testTracker() {
    const riotId = (store.get('riotId') || '').trim();
    if (!riotId || !riotId.includes('#')) {
      return { ok: false, error: 'Enter your Riot ID as Name#TAG first.' };
    }
    const stats = await fetchTrackerStats(true);
    if (stats) {
      if (engine) engine.setPlayerStats(stats);
      return { ok: true, stats };
    }
    return { ok: false, error: statsCache.lastError || 'Could not reach the stats service. Try again in a minute.' };
  },

  /** Player rated a tip (live or archived session). Ratings persist to disk
   *  so ✓/✗ marks survive restarts; bad tips feed the avoidance loop. */
  rateTip(payload) {
    const text   = payload && String(payload.text || '').trim();
    const rating = payload && payload.rating;
    if (!text || (rating !== 'good' && rating !== 'bad')) return;
    state.tipRatings[text] = rating;
    const keys = Object.keys(state.tipRatings);
    if (keys.length > 400) delete state.tipRatings[keys[0]];   // oldest-first trim
    store.set('tipRatings', state.tipRatings);
    if (rating === 'bad') {
      const bad = store.get('badTips') || [];
      if (!bad.includes(text)) {
        bad.unshift(text);
        store.set('badTips', bad.slice(0, 200));   // persistent blocklist
      }
      if (engine) engine.noteBadTip(text);
      console.log('[tips] rated BAD:', text.slice(0, 60));
    } else {
      console.log('[tips] rated good:', text.slice(0, 60));
    }
    registry.broadcast(C.PUSH_STATE, buildState());
  },
  logout() {
    logoutToActivation('You have been logged out. Enter a license key to sign back in.');
  },
  finishOnboarding() {
    store.set('onboardingCompleted', true);
    onboardingWindow.close();
  },
  onConfigChanged() {
    if (engine) engine.setPerformanceMode(store.get('performanceMode'));
    registry.broadcast(C.PUSH_STATE, buildState());
  },
  quit() { cleanupAndQuit(); },
};

// Tracker stats for the player's saved Riot ID. Persisted to disk so the link
// survives restarts ("always connected"): the last good profile is seeded from
// the store on boot and returned instantly, while a background refresh updates
// it. Returns the profile object or null.
let statsCache = { at: 0, riotId: '', data: null, lastError: null };
(function seedStatsFromDisk() {
  try {
    const savedId = (store.get('riotId') || '').trim();
    const saved   = store.get('playerStats');
    // Only reuse the saved profile if it belongs to the current Riot ID.
    // at: 0 means "usable as a fallback but always due for refresh", so a
    // days-old disk profile is never treated as current just because the
    // app restarted; the next stats request pulls fresh data.
    if (savedId && saved && saved._riotId === savedId) {
      statsCache = { at: 0, riotId: savedId, data: saved, lastError: null };
    }
  } catch {}
})();

async function fetchTrackerStats(force) {
  const riotId = (store.get('riotId') || '').trim();
  if (!riotId || !riotId.includes('#')) return null;
  if (!force && statsCache.data && statsCache.riotId === riotId && Date.now() - statsCache.at < 10 * 60 * 1000) {
    return statsCache.data;
  }
  try {
    const { ok, data } = await api.get('/api/coach/player-stats?username=' + encodeURIComponent(riotId), store.get('licenseKey'), 15000);
    const stats = ok && data && !data.error ? data : null;
    if (stats) {
      statsCache = { at: Date.now(), riotId, data: stats, lastError: null };
      store.set('playerStats', { ...stats, _riotId: riotId });   // persist = always connected
    } else {
      // Keep serving the last good profile on a transient failure; just note why.
      statsCache.lastError = (data && data.error) || 'Could not reach the stats service.';
      statsCache.riotId = riotId;
    }
    return stats || (statsCache.riotId === riotId ? statsCache.data : null);
  } catch {
    return statsCache.riotId === riotId ? statsCache.data : null;
  }
}

/** The most recent COMPLETED competitive match from the tracker, only when
 *  it ended recently enough to plausibly be this session's match (3 hours).
 *  Null when unavailable; the review simply shows without match stats. */
async function fetchLastMatch() {
  const riotId = (store.get('riotId') || '').trim();
  const licenseKey = store.get('licenseKey');
  if (!riotId || !riotId.includes('#') || !licenseKey) return null;
  try {
    const { ok, data } = await api.get('/api/coach/last-match?username=' + encodeURIComponent(riotId), licenseKey, 15000);
    if (!ok || !data || data.error || !data.result) return null;
    if (!data.startedAt || Date.now() - data.startedAt > 3 * 60 * 60 * 1000) return null;
    return data;
  } catch { return null; }
}

// ── Session performance log (extended stats dashboard) ──────────────────────
// One small record per coached session (four category scores + strengths and
// weaknesses text). Kept in its own file, NOT the 7-day session archive, so
// trends survive pruning. Capped at the last 100 sessions.
let matchesClient = { data: null, fetchedAt: 0, lastManual: 0 };   // tracker match list cache

function perfFile() { return path.join(app.getPath('userData'), 'performance.json'); }
function loadPerf() {
  try {
    const a = JSON.parse(fs.readFileSync(perfFile(), 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function appendPerf(rec) {
  try {
    const all = loadPerf();
    all.push(rec);
    fs.writeFileSync(perfFile(), JSON.stringify(all.slice(-100), null, 2));
  } catch (e) { console.error('[perf] save failed:', e.message); }
}

/** Have the server grade the finished session (0-100 per category plus
 *  strengths/weaknesses from the tips), then log it locally. Fire and forget:
 *  a failure just means this session shows no score card. */
async function logSessionPerformance(tips, mctx) {
  try {
    if (!Array.isArray(tips) || tips.length < 3) return;
    const { ok, data } = await api.post('/api/coach/score-session',
      { tips: tips.slice(0, 30), context: { map: mctx.map, agent: mctx.agent } },
      store.get('licenseKey'), 20000);
    if (!ok || !data || data.error || data.economy == null) return;
    const scores = { economy: data.economy, positioning: data.positioning,
                     utility: data.utility, aim: data.aim };
    appendPerf({
      at: Date.now(),
      map: mctx.map || null,
      agent: mctx.agent || null,
      scores,
      overall: Math.round((scores.economy + scores.positioning + scores.utility + scores.aim) / 4),
      strengths:  data.strengths  || '',
      weaknesses: data.weaknesses || '',
    });
    console.log('[perf] session scored and logged');
  } catch (e) { console.error('[perf] scoring failed:', e.message); }
}

// Rank ladder for trend arrows: "Gold 2" -> comparable number. Unknown -> null.
const RANK_LADDER = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'ascendant', 'immortal', 'radiant'];
function rankIndex(r) {
  const l = String(r || '').toLowerCase();
  const i = RANK_LADDER.findIndex((t) => l.startsWith(t));
  if (i < 0) return null;
  const div = parseInt(l.replace(/[^\d]/g, ''), 10);
  return i * 3 + (isNaN(div) ? 2 : div);
}
function trendDirection(cur, prev, deadband = 2) {
  if (cur == null || prev == null) return 'flat';
  const d = cur - prev;
  return d > deadband ? 'up' : d < -deadband ? 'down' : 'flat';
}

/** Pro Playbook mode from the store, normalized: earlier builds stored a
 *  boolean (true meant on); the setting is now 'off' | 'on' | 'hybrid'. */
function playbookMode() {
  const v = store.get('proPlaybook');
  if (v === true) return 'on';
  return v === 'on' || v === 'hybrid' ? v : 'off';
}

// ── Session archive ──────────────────────────────────────────────────────────
// Every coaching session is saved to disk so players can review past sessions
// in the History window, even when tips were hidden during play.
function sessionsDir() {
  return path.join(app.getPath('userData'), 'sessions');
}

function saveSessionArchive(extra = {}) {
  try {
    if (!state.tips.length) return;
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const endedAt = Date.now();
    const file = `session-${new Date(endedAt).toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(dir, file), JSON.stringify({
      endedAt,
      agent:    (state.agent && state.agent.agent) || null,
      tipCount: state.tips.length,
      tipMix:   extra.tipMix || null,
      tips:     state.tips,
      matchMemory: extra.matchMemory || [],
      stats:    extra.stats || store.get('playerStats') || null,
    }, null, 2));
    console.log('[session] archived', file, `(${state.tips.length} tips)`);
    cleanupOldSessions();
  } catch (e) {
    console.error('[session] archive failed:', e.message);
  }
}

const SESSION_FILE_RE = /^session-[\dTZ-]+\.json$/;

/** Sessions auto-expire after a week so the archive never clutters up. */
function cleanupOldSessions() {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!SESSION_FILE_RE.test(f)) continue;
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); console.log('[session] pruned (7 days):', f); }
      } catch {}
    }
  } catch {}
}

function listSessions() {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!SESSION_FILE_RE.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push({ file: f, endedAt: j.endedAt || 0, tipCount: j.tipCount || 0, agent: j.agent || null });
      } catch {}
    }
    out.sort((a, b) => b.endedAt - a.endedAt);
    return out.slice(0, 30);
  } catch {
    return [];
  }
}

function getSession(file) {
  try {
    const base = path.basename(String(file || ''));
    if (!SESSION_FILE_RE.test(base)) return null;   // no traversal, strict name
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(), base), 'utf8'));
  } catch {
    return null;
  }
}

function saveMatchSummary(data) {
  try {
    const dir = path.join(app.getPath('userData'), 'match-summaries');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `match-${ts}.json`), JSON.stringify(data, null, 2));
    console.log('[match] summary saved');
  } catch (err) {
    console.error('[match] save failed:', err.message);
  }
}

// ── License (real service) ───────────────────────────────────────────────────
// Thin adapter over license-service that also drives the window transitions
// (close activation + launch the app) on a successful activation.
const license = {
  async activate(key) {
    const result = await licenseService.activate(key);
    if (result.valid) {
      state.licenseActive = true;   // clear any prior "ended" lock
      state.licenseReason = '';
      activationWindow.close();
      launchMainApp();
    }
    return result;
  },
  getCached() { return licenseService.getCached(); },
};

// ── Subscription lifecycle (soft lock) ───────────────────────────────────────
// When the subscription ends we DON'T force the user out; we stop all coaching
// (no AI and no library tips) and surface the ended state in the panel + Settings
// so they can renew. Coaching stays disabled until a re-validation says active.
function enterLicenseEnded(reason) {
  state.licenseReason = reason || state.licenseReason || 'expired';
  if (!state.licenseActive) { registry.broadcast(C.PUSH_STATE, buildState()); return; }
  state.licenseActive = false;
  console.warn('[license] subscription ended:', state.licenseReason);
  if (state.isCoaching) controller.stop();   // kills the engine: no more tips at all
  const msg = licenseService.messageForStatus(state.licenseReason) ||
    'Your GhostCoach subscription has ended. Renew to keep coaching.';
  pushTip({ text: msg, source: 'system' });  // one notice explaining why tips stopped
  registry.broadcast(C.PUSH_STATE, buildState());
}

function exitLicenseEnded() {
  if (state.licenseActive) return;
  state.licenseActive = true;
  state.licenseReason = '';
  console.log('[license] subscription active again');
  registry.broadcast(C.PUSH_STATE, buildState());
}

// Authoritative check: only the license endpoint decides active vs ended.
function revalidateNow() {
  licenseService.revalidate()
    .then((r) => {
      if (r.valid === false) enterLicenseEnded(r.status);
      else if (r.valid)      exitLicenseEnded();
    })
    .catch(() => {});
}

// Tear down the running session (windows, engine, tray, hotkeys) WITHOUT quitting
// the app, so we can return to the activation window.
function teardownSession() {
  try { if (engine) { engine.stop(); engine = null; } } catch (e) {}
  try { hotkeys.unregister(); } catch (e) {}
  try { tray.destroy(); } catch (e) {}
  try { capture.disposeWorker(); } catch (e) {}
  for (const name of ['dock', 'history', 'settings', 'overlay', 'panel']) {
    const w = registry.get(name);
    if (w && !w.isDestroyed()) w.destroy();
  }
  state.isCoaching = false;
  state.isPaused   = false;
  state.status     = 'idle';
  state.tips       = [];
  state.agent      = { agent: null, confirmed: false, role: null };
}

// Log the user out: clear the cached license, tear the session down, and show the
// activation window. Stays logged out until a new key is activated.
function logoutToActivation(reason) {
  stopLicenseWatch();
  licenseService.clear();
  teardownSession();
  mainLaunched = false;
  console.log('[license] logged out', reason ? `(${reason})` : '(manual)');
  activationWindow.create(reason);
}

// ── License watchdog ─────────────────────────────────────────────────────────
// Every minute: an offline-safe expiry check (the cached expiry date passing).
// Every ~10 minutes: a server re-validation, and a state broadcast so the open
// Settings window always reflects the current plan/status/expiry.
let licenseWatch = null;
let licenseTick  = 0;
function startLicenseWatch() {
  stopLicenseWatch();
  licenseTick = 0;
  licenseWatch = setInterval(() => {
    if (!mainLaunched) return;
    // Offline-safe: the cached expiry date has passed. (Doesn't return early, so
    // the server re-check below can still detect a renewal.)
    if (state.licenseActive && !licenseService.isLocallyValid()) {
      const status = store.get('licenseStatus');
      enterLicenseEnded(status && status !== 'active' ? status : 'expired');
    }
    // Server re-check every ~3 minutes: catches a server-side end AND a renewal,
    // and keeps the open Settings window's license block fresh.
    if (++licenseTick % 3 === 0 && store.get('licenseKey')) {
      licenseService.revalidate()
        .then((r) => {
          if (r.valid === false) enterLicenseEnded(r.status);
          else if (r.valid)      exitLicenseEnded();
          registry.broadcast(C.PUSH_STATE, buildState());
        })
        .catch(() => {});
    }
  }, 60 * 1000);
}
function stopLicenseWatch() {
  if (licenseWatch) { clearInterval(licenseWatch); licenseWatch = null; }
}

// ── Tray / hotkey action maps ────────────────────────────────────────────────
const trayActions = {
  start:          () => controller.start(),
  stop:           () => controller.stop(),
  toggleOverlay:  () => controller.toggleOverlay(),
  toggleMinimize: () => controller.toggleMinimizePanel(),
  isMinimized:    () => panelWindow.isMinimized(),
  openSettings:   () => controller.openSettings(),
  openHistory:    () => controller.openHistory(),
  quit:           () => controller.quit(),
};

const hotkeyActions = {
  toggleOverlay:  () => controller.toggleOverlay(),
  forceTip:       () => controller.forceTip(),
  pauseResume:    () => controller.pauseResume(),
  minimizePanel:  () => controller.toggleMinimizePanel(),
  openSettings:   () => controller.openSettings(),
  openHistory:    () => controller.openHistory(),
};

// ── Launch ───────────────────────────────────────────────────────────────────
function launchMainApp() {
  if (mainLaunched) return;
  mainLaunched = true;

  overlayWindow.create();
  panelWindow.create();
  tray.create(trayActions);
  hotkeys.register(hotkeyActions);

  // Send an initial state snapshot once the panel has loaded.
  const panel = panelWindow.get();
  if (panel) {
    panel.webContents.once('did-finish-load', () => {
      setTimeout(() => registry.broadcast(C.PUSH_STATE, buildState()), 200);
    });
  }
  startLicenseWatch(); // detect expiry / revocation mid-session and keep Settings fresh
  cleanupOldSessions(); // prune week-old session archives on every launch

  // Stay connected to the tracker across restarts: refresh the saved profile in
  // the background so live tips + chat have current stats without reconnecting.
  if ((store.get('riotId') || '').trim()) {
    fetchTrackerStats(true).then((s) => { if (s && engine) engine.setPlayerStats(s); }).catch(() => {});
  }

  // First launch after activation: show the one-time welcome card (hotkey tour).
  if (!store.get('onboardingCompleted')) onboardingWindow.create();

  console.log('[main] Main app launched');
}

function cleanupAndQuit() {
  try {
    if (state.isCoaching && engine) {
      saveSessionArchive({
        tipMix: engine.getMix(),
        matchMemory: engine.matchMemory.slice(),
      });
    }
    if (engine) { engine.stop(); engine = null; }
    capture.disposeWorker();
    hotkeys.unregister();
    globalShortcut.unregisterAll();
    tray.destroy();
  } catch (err) {
    console.error('[cleanup]', err.message);
  }
  app.quit();
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.setAppUserModelId('com.ghostcoach.app2');

// Single instance, focus existing rather than launching a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = registry.get('panel') || registry.get('activation');
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    logger.init(app);
    console.log('[main] Ready. Debug log:', logger.getLogPath());

    registerIpc({ controller, license });

    // Dev-only self-test (never runs in normal use): bypasses the license server
    // and exercises launch → IPC round-trip, writing results to debug.log.
    if (process.env.GHOST_DEV_AUTOLAUNCH === '1') {
      setTimeout(() => {
        console.log('[dev] auto-launch (license bypassed) for self-test');
        launchMainApp();
        controller.start();
        if (process.env.GHOST_DEV_OPEN_SETTINGS === '1') settingsWindow.open();
        if (process.env.GHOST_DEV_FAKE_MIX === '1' && engine) {
          ['Pre-aim the angle before you swing, do not react after.',
           'Trade your teammate, swing right as they take the duel.',
           'Reposition after the kill, never repeek the same spot.',
           'Use util before peeking, flash or smoke the angle first.',
           'Check your minimap, rotate early on solid info.'].forEach((t) => engine.emitTip(t, 'ai'));
          engine.emitTip('Reset your mental, the next round is a fresh start.', 'library');
          engine.emitTip('Default first, take map control, then commit as five.', 'library');
        }
        if (process.env.GHOST_DEV_OPEN_HISTORY === '1') historyWindow.open();
        if (process.env.GHOST_DEV_MINIMIZE === '1') setTimeout(() => controller.toggleMinimizePanel(), 1200);
        const panel = panelWindow.get();
        if (panel) {
          panel.webContents.once('did-finish-load', () =>
            setTimeout(() => controller.forceTip(), 800));
        }
        if (process.env.GHOST_DEV_NOQUIT !== '1') {
          setTimeout(() => { console.log('[dev] self-test: forcing quit'); cleanupAndQuit(); }, 4000);
        }
      }, 800);
      return;
    }

    // Dev-only: drive the REAL license path (service → live server → persist →
    // launch) with a key from the env. Lets us verify activation from the CLI.
    if (process.env.GHOST_DEV_ACTIVATE_KEY) {
      if (!licenseService.isLocallyValid()) activationWindow.create();
      license.activate(process.env.GHOST_DEV_ACTIVATE_KEY).then((r) => {
        console.log('[dev] activate result:', JSON.stringify(r));
        if (!r.valid && process.env.GHOST_DEV_NOQUIT !== '1') {
          setTimeout(() => { console.log('[dev] quitting after failed activation'); cleanupAndQuit(); }, 1500);
        }
      });
      return;
    }

    // Trust-cache, re-activate in background: if a locally-valid license is
    // cached, launch instantly and silently re-check; only sign out on an
    // explicit valid:false. Otherwise show the activation window.
    if (licenseService.isLocallyValid()) {
      launchMainApp();
      licenseService.revalidate()
        .then((r) => { if (r.valid === false) enterLicenseEnded(r.status); })
        .catch((err) => console.warn('[license] revalidate failed:', err.message));
    } else {
      activationWindow.create();
    }
  });

  app.on('window-all-closed', () => {
    // Tray keeps the app alive; quit only via explicit action.
  });

  app.on('will-quit', () => {
    hotkeys.unregister();
    globalShortcut.unregisterAll();
  });
}

// ── Crash safety ─────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[crash] uncaughtException:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[crash] unhandledRejection:', reason);
});
