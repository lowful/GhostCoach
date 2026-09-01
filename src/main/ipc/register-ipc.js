'use strict';

const { ipcMain, shell } = require('electron');
const C = require('../../shared/channels');
const { PURCHASE_URL } = require('../../shared/config');
const store = require('../services/store');
const updater = require('../updater');

/**
 * Registers every ipcMain handler in one place. All channel names come from the
 * shared registry. `deps` injects the pieces that change across phases so this
 * file never needs to know how coaching/licensing are implemented.
 *
 * deps = {
 *   controller: { start, stop, pauseResume, forceTip, getState, toggleOverlay, openSettings, quit },
 *   license:    { activate(key) → result, getCached() → {...} },
 * }
 */
function registerIpc(deps) {
  const { controller, license } = deps;

  // ── request/response ──────────────────────────────────────────────────────
  safeHandle(C.LICENSE_ACTIVATE, async (_e, key) => license.activate(key));

  safeHandle(C.LICENSE_GET, async () => license.getCached());

  safeHandle(C.CONFIG_GET, async () => snapshotConfig());

  safeHandle(C.CONFIG_SET, async (_e, partial) => {
    if (partial && typeof partial === 'object') {
      for (const [k, v] of Object.entries(partial)) store.set(k, v);
    }
    controller.onConfigChanged?.();
    return { ok: true, config: snapshotConfig() };
  });

  safeHandle(C.STATE_GET, async () => controller.getState());

  safeHandle(C.COACH_FORCE_TIP, async () => {
    await controller.forceTip();
    return { ok: true };
  });

  safeHandle(C.AGENT_SET, async (_e, name) => controller.setAgent(name));

  safeHandle(C.CHAT_SEND, async (_e, messages) => controller.chat(messages));

  safeHandle(C.STATS_TEST, async () => controller.testTracker());

  safeHandle(C.SESSIONS_LIST, async () => controller.listSessions());
  safeHandle(C.SESSION_GET, async (_e, file) => controller.getSession(file));

  safeHandle(C.STATS_DASHBOARD, async (_e, mode, force) => controller.getStatsDashboard(mode, force));
  safeHandle(C.STATS_REFRESH, async (_e, mode) => controller.getMatches(true, mode));
  safeHandle(C.STATS_MATCHES, async (_e, mode) => controller.getMatches(false, mode));
  safeHandle(C.STATS_RANK_HISTORY, async (_e, force) => controller.getRankHistory(force));
  safeHandle(C.CHAT_SEED, async () => controller.takeChatSeed());
  safeHandle(C.WEEKLY_GET, async () => controller.getWeeklyReport());
  safeHandle(C.AILOG_GET, async (_e, id) => controller.getAiLog(id));
  safeHandle(C.AILOG_SESSIONS, async () => controller.getAiLogSessions());
  safeHandle(C.AILOG_CONFIRM, async (_e, id) => controller.confirmAiLogDeaths(id));
  safeHandle(C.AILOG_ASK, async (_e, payload) => controller.askAboutFrame(payload));
  safeHandle(C.APP_VERSION, async () => updater.getStatus());
  safeHandle(C.APP_UPDATE_CHECK, async () => updater.checkNow());

  // ── fire-and-forget commands ──────────────────────────────────────────────
  ipcMain.on(C.COACH_START,    () => guard('start',    () => controller.start()));
  ipcMain.on(C.COACH_STOP,     () => guard('stop',     () => controller.stop()));
  ipcMain.on(C.COACH_PAUSE,    () => guard('pause',    () => controller.pauseResume()));
  ipcMain.on(C.OVERLAY_TOGGLE, () => guard('toggle',   () => controller.toggleOverlay()));
  ipcMain.on(C.OVERLAY_INTERACT, (_e, on) => guard('overlayInteract', () => controller.setOverlayInteractive(!!on)));
  ipcMain.on(C.AGENT_CONFIRM,  () => guard('agentConfirm', () => controller.confirmAgent()));
  ipcMain.on(C.PANEL_RESIZE,   (_e, h) => guard('panelResize', () => controller.resizePanel(h)));
  ipcMain.on(C.PANEL_MINIMIZE, () => guard('minimize', () => controller.toggleMinimizePanel()));
  ipcMain.on(C.OPEN_SETTINGS,  () => guard('settings', () => controller.openSettings()));
  ipcMain.on(C.OPEN_HISTORY,   () => guard('history',  () => controller.openHistory()));
  ipcMain.on(C.OPEN_CHAT,      () => guard('chat',     () => controller.openChat()));
  ipcMain.on(C.OPEN_STATS,     () => guard('stats',    () => controller.openStats()));
  ipcMain.on(C.OPEN_WEEKLY,    () => guard('weekly',   () => controller.openWeekly()));
  ipcMain.on(C.OPEN_AILOG,     (_e, sessionId) => guard('ailog', () => controller.openAiLog(sessionId)));
  ipcMain.on(C.OPEN_CHAT_SEEDED, (_e, seed) => guard('chatSeeded', () => controller.openChatSeeded(seed)));
  ipcMain.on(C.TIP_RATE,       (_e, payload) => guard('rateTip', () => controller.rateTip(payload)));
  ipcMain.on(C.OPEN_PURCHASE,  () => guard('purchase', () => shell.openExternal(PURCHASE_URL)));
  ipcMain.on(C.LICENSE_LOGOUT, () => guard('logout',   () => controller.logout()));
  ipcMain.on(C.ONBOARDING_DONE,() => guard('onboarding', () => controller.finishOnboarding()));
  ipcMain.on(C.AUDIO_CLIP,     (_e, b64) => guard('audioClip', () => controller.onAudioClip(b64)));
  ipcMain.on(C.APP_QUIT,       () => guard('quit',     () => controller.quit()));
}

function snapshotConfig() {
  const stats = store.get('playerStats');
  return {
    performanceMode: store.get('performanceMode'),
    riotId:          store.get('riotId'),
    playerStats:     stats && stats._riotId === (store.get('riotId') || '').trim() ? stats : null,
    overlayPosition: store.get('overlayPosition'),
    tipPosition:     store.get('tipPosition'),
    tipScale:        store.get('tipScale'),
    tipStyle:        store.get('tipStyle'),
    tipOpacity:      store.get('tipOpacity'),
    showTips:        store.get('showTips'),
    beginnerTips:    store.get('beginnerTips'),
    aiLog:           store.get('aiLog'),
    voiceCoach:      store.get('voiceCoach'),
    voiceStyle:      store.get('voiceStyle'),
    voiceVolume:     store.get('voiceVolume'),
    panelMinimized:  store.get('panelMinimized'),
    // WRITTEN BUT NEVER READ BACK, which is why the language would not stick.
    //
    // setConfig persists any key, so choosing a language saved correctly and the
    // coaching tips followed it immediately, because the engine reads
    // store.get('language') directly. This snapshot is the renderer's ONLY view
    // of the config though, and language was missing from the list, so:
    //   - Settings read cfg.language as undefined and reset the picker to
    //     English every time it opened, making a saved choice look discarded
    //   - initI18n resolved the language to English on every refresh, so no
    //     window ever repainted, in any language
    // The result was an app that coached in German and looked entirely English,
    // and a Save button that appeared to do nothing. One missing line.
    language:        store.get('language'),
    captureQuality:  store.get('captureQuality'),
    // The renderer needs this to paint the right palette. A setting the
    // renderer writes but cannot read back is exactly how the language setting
    // silently never applied, which is what check:config now exists to catch.
    game:            store.get('game'),
    devGames:        store.get('devGames'),
  };
}

function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

function guard(label, fn) {
  try { fn(); }
  catch (err) { console.error(`[ipc] ${label} failed:`, err.message); }
}

module.exports = registerIpc;
