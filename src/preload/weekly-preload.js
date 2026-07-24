'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Weekly report bridge: read the report, jump into the full dashboard or Ask
 * Coach from it, and close the popup.
 */
contextBridge.exposeInMainWorld('ghost', {
  getReport: () => ipcRenderer.invoke(C.WEEKLY_GET),
  openStats: () => ipcRenderer.send(C.OPEN_STATS),
  openChat:  () => ipcRenderer.send(C.OPEN_CHAT),
  close:     () => window.close(),
});
