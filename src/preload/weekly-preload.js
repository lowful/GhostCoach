'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

/**
 * Weekly report bridge: read the report, jump into the full dashboard or Ask
 * Coach from it, and close the popup.
 */
contextBridge.exposeInMainWorld('ghost', {
  // i18n: the catalogue is required here (preloads have Node) and handed to the
  // renderer as a plain translator, so no surface needs Node access to be
  // translated. Read at call time, so a language change repaints correctly.
  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  getReport: () => ipcRenderer.invoke(C.WEEKLY_GET),
  openStats: () => ipcRenderer.send(C.OPEN_STATS),
  openChat:  () => ipcRenderer.send(C.OPEN_CHAT),
  close:     () => window.close(),
});
