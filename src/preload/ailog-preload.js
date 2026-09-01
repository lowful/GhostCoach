'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

/** AI decision-log viewer bridge: read the latest session, close the window. */
contextBridge.exposeInMainWorld('occlara', {
  // i18n: the catalogue is required here (preloads have Node) and handed to the
  // renderer as a plain translator, so no surface needs Node access to be
  // translated. Read at call time, so a language change repaints correctly.
  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  // getLog(id) loads one session WITH its frames, so it is the expensive call.
  // sessions() is metadata only and is what the picker is built from.
  getLog:   (id) => ipcRenderer.invoke(C.AILOG_GET, id),
  sessions: () => ipcRenderer.invoke(C.AILOG_SESSIONS),
  // Checks the log's deaths against Riot. Called after the session is on screen,
  // never before, so the viewer stays instant and works with no network.
  confirm:  (id) => ipcRenderer.invoke(C.AILOG_CONFIRM, id),
  ask:      (payload) => ipcRenderer.invoke(C.AILOG_ASK, payload),
  // Jump an already open window to another session, for a second link from
  // Tip History while this one is on screen.
  onShow:   (cb) => ipcRenderer.on(C.AILOG_SHOW, (_e, id) => cb(id)),
  close:  () => window.close(),
});
