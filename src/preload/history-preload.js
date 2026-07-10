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
  getState:     () => ipcRenderer.invoke(C.STATE_GET),
  listSessions: () => ipcRenderer.invoke(C.SESSIONS_LIST),
  getSession:   (file) => ipcRenderer.invoke(C.SESSION_GET, file),
  rateTip:      (payload) => ipcRenderer.send(C.TIP_RATE, payload),
  onTip:        (cb) => subscribe(C.PUSH_TIP, cb),
  onState:      (cb) => subscribe(C.PUSH_STATE, cb),
});
