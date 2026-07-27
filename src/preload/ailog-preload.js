'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/** AI decision-log viewer bridge: read the latest session, close the window. */
contextBridge.exposeInMainWorld('ghost', {
  getLog: () => ipcRenderer.invoke(C.AILOG_GET),
  ask:    (payload) => ipcRenderer.invoke(C.AILOG_ASK, payload),
  close:  () => window.close(),
});
