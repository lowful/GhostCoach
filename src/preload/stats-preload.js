'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

/**
 * Stats dashboard bridge: read the assembled dashboard, refresh tracker
 * matches (rate limited), and hand a session's context to Ask Coach.
 */
contextBridge.exposeInMainWorld('occlara', {
  // i18n: the catalogue is required here (preloads have Node) and handed to the
  // renderer as a plain translator, so no surface needs Node access to be
  // translated. Read at call time, so a language change repaints correctly.
  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  getDashboard:    (mode, force) => ipcRenderer.invoke(C.STATS_DASHBOARD, mode, force),
  refreshMatches:  (mode) => ipcRenderer.invoke(C.STATS_REFRESH, mode),
  matchesFor:      (mode) => ipcRenderer.invoke(C.STATS_MATCHES, mode),
  rankHistory:     (force) => ipcRenderer.invoke(C.STATS_RANK_HISTORY, force),
  openChat:        () => ipcRenderer.send(C.OPEN_CHAT),
  openWeekly:      () => ipcRenderer.send(C.OPEN_WEEKLY),
  openAiLog:       (sessionId) => ipcRenderer.send(C.OPEN_AILOG, sessionId || null),
  askAboutSession: (seed) => ipcRenderer.send(C.OPEN_CHAT_SEEDED, seed),
  // Pushed app state; the stats window watches it to follow a Riot ID switch.
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on(C.PUSH_STATE, h);
    return () => ipcRenderer.removeListener(C.PUSH_STATE, h);
  },
});
