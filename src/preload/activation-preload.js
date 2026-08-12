'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

/**
 * Activation bridge, submit a license key and open the purchase page.
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

  activate:     (key) => ipcRenderer.invoke(C.LICENSE_ACTIVATE, key),
  openPurchase: () => ipcRenderer.send(C.OPEN_PURCHASE),
  quit:         () => ipcRenderer.send(C.APP_QUIT),
});
