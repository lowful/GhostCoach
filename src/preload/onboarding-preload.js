'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Onboarding bridge: a single action, dismiss the welcome card for good.
 */
contextBridge.exposeInMainWorld('ghost', {
  done: () => ipcRenderer.send(C.ONBOARDING_DONE),
});
