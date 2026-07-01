'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * History bridge, pull the current tip list and stay live as new tips arrive.
 */
function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ghost', {
  getState: () => ipcRenderer.invoke(C.STATE_GET),
  onTip:    (cb) => subscribe(C.PUSH_TIP, cb),
  onState:  (cb) => subscribe(C.PUSH_STATE, cb),
});
