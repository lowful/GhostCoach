'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Onboarding bridge: dismiss the welcome card for good, and save the
 * fundamental-tips answer (the curated library mix) straight to config.
 */
contextBridge.exposeInMainWorld('ghost', {
  done: () => ipcRenderer.send(C.ONBOARDING_DONE),
  setFundamentals: (on) => ipcRenderer.invoke(C.CONFIG_SET, { beginnerTips: !!on }),
  // The tour lets the player pick their tip look; it writes to the same config
  // the Settings window uses, so the two can never disagree.
  setConfig: (patch) => ipcRenderer.invoke(C.CONFIG_SET, patch),
  getConfig: () => ipcRenderer.invoke(C.CONFIG_GET),
});
