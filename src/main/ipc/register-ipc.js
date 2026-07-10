'use strict';

const { ipcMain, shell } = require('electron');
const C = require('../../shared/channels');
const { PURCHASE_URL } = require('../../shared/config');
const store = require('../services/store');

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

  safeHandle(C.CHAT_SEND, async (_e, messages, opts) => controller.chat(messages, opts));

  safeHandle(C.STATS_TEST, async () => controller.testTracker());

  safeHandle(C.SESSIONS_LIST, async () => controller.listSessions());
  safeHandle(C.SESSION_GET, async (_e, file) => controller.getSession(file));

  // ── fire-and-forget commands ──────────────────────────────────────────────
  ipcMain.on(C.COACH_START,    () => guard('start',    () => controller.start()));
  ipcMain.on(C.COACH_STOP,     () => guard('stop',     () => controller.stop()));
  ipcMain.on(C.COACH_PAUSE,    () => guard('pause',    () => controller.pauseResume()));
  ipcMain.on(C.OVERLAY_TOGGLE, () => guard('toggle',   () => controller.toggleOverlay()));
  ipcMain.on(C.AGENT_CONFIRM,  () => guard('agentConfirm', () => controller.confirmAgent()));
  ipcMain.on(C.PANEL_RESIZE,   (_e, h) => guard('panelResize', () => controller.resizePanel(h)));
  ipcMain.on(C.PANEL_MINIMIZE, () => guard('minimize', () => controller.toggleMinimizePanel()));
  ipcMain.on(C.OPEN_SETTINGS,  () => guard('settings', () => controller.openSettings()));
  ipcMain.on(C.OPEN_HISTORY,   () => guard('history',  () => controller.openHistory()));
  ipcMain.on(C.OPEN_CHAT,      () => guard('chat',     () => controller.openChat()));
  ipcMain.on(C.TIP_RATE,       (_e, payload) => guard('rateTip', () => controller.rateTip(payload)));
  ipcMain.on(C.OPEN_PURCHASE,  () => guard('purchase', () => shell.openExternal(PURCHASE_URL)));
  ipcMain.on(C.LICENSE_LOGOUT, () => guard('logout',   () => controller.logout()));
  ipcMain.on(C.ONBOARDING_DONE,() => guard('onboarding', () => controller.finishOnboarding()));
  ipcMain.on(C.APP_QUIT,       () => guard('quit',     () => controller.quit()));
}

function snapshotConfig() {
  const stats = store.get('playerStats');
  return {
    performanceMode: store.get('performanceMode'),
    captureQuality:  store.get('captureQuality'),
    riotId:          store.get('riotId'),
    playerStats:     stats && stats._riotId === (store.get('riotId') || '').trim() ? stats : null,
    overlayPosition: store.get('overlayPosition'),
    tipPosition:     store.get('tipPosition'),
    tipScale:        store.get('tipScale'),
    showTips:        store.get('showTips'),
    panelMinimized:  store.get('panelMinimized'),
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
