'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

// Display-only badge, just listens for coaching status to pulse appropriately.
contextBridge.exposeInMainWorld('ghost', {
  // i18n: the catalogue is required here (preloads have Node) and handed to the
  // renderer as a plain translator, so no surface needs Node access to be
  // translated. Read at call time, so a language change repaints correctly.
  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  onStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(C.PUSH_STATUS, handler);
    return () => ipcRenderer.removeListener(C.PUSH_STATUS, handler);
  },
});
