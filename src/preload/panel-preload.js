'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');
const GAMES = require('../shared/games');

/**
 * Control panel bridge, the interactive hub. Sends commands to main and
 * subscribes to state/status pushes.
 */
function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ghost', {
  // i18n: the catalogue is required here (preloads have Node) and handed to the
  // renderer as a plain translator, so no surface needs Node access to be
  // translated. Read at call time, so a language change repaints correctly.
  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  // The game switcher moved into the panel header, so the panel needs the
  // registry and the config that Settings already had. Handed over as plain
  // data, so no surface gains Node access.
  games: {
    list: (includeUnavailable) => GAMES.list(includeUnavailable)
      .map((g) => ({ id: g.id, label: g.label, coaching: !!g.coaching, preview: !!g.preview })),
  },

  getConfig: () => ipcRenderer.invoke(C.CONFIG_GET),
  setConfig: (partial) => ipcRenderer.invoke(C.CONFIG_SET, partial),

  // commands
  startCoaching: () => ipcRenderer.send(C.COACH_START),
  stopCoaching:  () => ipcRenderer.send(C.COACH_STOP),
  pauseResume:   () => ipcRenderer.send(C.COACH_PAUSE),
  toggleOverlay: () => ipcRenderer.send(C.OVERLAY_TOGGLE),
  confirmAgent:  () => ipcRenderer.send(C.AGENT_CONFIRM),
  resizePanel:   (h) => ipcRenderer.send(C.PANEL_RESIZE, h),
  minimize:      () => ipcRenderer.send(C.PANEL_MINIMIZE),
  openSettings:  () => ipcRenderer.send(C.OPEN_SETTINGS),
  openHistory:   () => ipcRenderer.send(C.OPEN_HISTORY),
  openChat:      () => ipcRenderer.send(C.OPEN_CHAT),
  openStats:     () => ipcRenderer.send(C.OPEN_STATS),
  quit:          () => ipcRenderer.send(C.APP_QUIT),
  // request/response
  forceTip:      () => ipcRenderer.invoke(C.COACH_FORCE_TIP),
  getState:      () => ipcRenderer.invoke(C.STATE_GET),
  setAgent:      (name) => ipcRenderer.invoke(C.AGENT_SET, name),
  // subscriptions
  onTip:    (cb) => subscribe(C.PUSH_TIP, cb),
  onStatus: (cb) => subscribe(C.PUSH_STATUS, cb),
  onState:  (cb) => subscribe(C.PUSH_STATE, cb),
  onAgent:  (cb) => subscribe(C.PUSH_AGENT, cb),
  onNudge:  (cb) => subscribe(C.PUSH_NUDGE, cb),
});
