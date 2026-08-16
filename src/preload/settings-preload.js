'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');
const GAMES = require('../shared/games');

/**
 * Settings bridge, read/write config + license info, plus live state.
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
  // The registry is required here (preloads have Node) and handed over as
  // plain data, so no surface needs Node access to draw the picker.
  games: {
    list: (includeUnavailable) => GAMES.list(includeUnavailable)
      .map((g) => ({ id: g.id, label: g.label, coaching: !!g.coaching, preview: !!g.preview })),
  },

  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  getConfig:    () => ipcRenderer.invoke(C.CONFIG_GET),
  setConfig:    (partial) => ipcRenderer.invoke(C.CONFIG_SET, partial),
  getLicense:   () => ipcRenderer.invoke(C.LICENSE_GET),
  getState:     () => ipcRenderer.invoke(C.STATE_GET),
  testTracker:  () => ipcRenderer.invoke(C.STATS_TEST),
  getVersion:   () => ipcRenderer.invoke(C.APP_VERSION),
  checkUpdate:  () => ipcRenderer.invoke(C.APP_UPDATE_CHECK),
  openPurchase: () => ipcRenderer.send(C.OPEN_PURCHASE),
  logout:       () => ipcRenderer.send(C.LICENSE_LOGOUT),
  quit:         () => ipcRenderer.send(C.APP_QUIT),
  onState:  (cb) => subscribe(C.PUSH_STATE, cb),
  onStatus: (cb) => subscribe(C.PUSH_STATUS, cb),
});
