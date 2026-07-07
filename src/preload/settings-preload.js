'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Settings bridge, read/write config + license info, plus live state.
 */
function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ghost', {
  getConfig:    () => ipcRenderer.invoke(C.CONFIG_GET),
  setConfig:    (partial) => ipcRenderer.invoke(C.CONFIG_SET, partial),
  getLicense:   () => ipcRenderer.invoke(C.LICENSE_GET),
  getState:     () => ipcRenderer.invoke(C.STATE_GET),
  testTracker:  () => ipcRenderer.invoke(C.STATS_TEST),
  openPurchase: () => ipcRenderer.send(C.OPEN_PURCHASE),
  logout:       () => ipcRenderer.send(C.LICENSE_LOGOUT),
  quit:         () => ipcRenderer.send(C.APP_QUIT),
  onState:  (cb) => subscribe(C.PUSH_STATE, cb),
  onStatus: (cb) => subscribe(C.PUSH_STATUS, cb),
});
