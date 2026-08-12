'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

/**
 * Onboarding bridge: dismiss the welcome card for good, and save the
 * fundamental-tips answer (the curated library mix) straight to config.
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

  done: () => ipcRenderer.send(C.ONBOARDING_DONE),
  setFundamentals: (on) => ipcRenderer.invoke(C.CONFIG_SET, { beginnerTips: !!on }),
  // The tour lets the player pick their tip look; it writes to the same config
  // the Settings window uses, so the two can never disagree.
  setConfig: (patch) => ipcRenderer.invoke(C.CONFIG_SET, patch),
  getConfig: () => ipcRenderer.invoke(C.CONFIG_GET),
});
