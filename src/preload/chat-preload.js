'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Ask Coach bridge: send a conversation turn (text only) and read session
 * state for context chips.
 */
function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ghost', {
  sendChat: (messages) => ipcRenderer.invoke(C.CHAT_SEND, messages),
  getState: () => ipcRenderer.invoke(C.STATE_GET),
  // Pending session context from the stats dashboard ("Ask Coach about this"),
  // cleared on read so it fires exactly once.
  getSeed:  () => ipcRenderer.invoke(C.CHAT_SEED),
  onState:  (cb) => subscribe(C.PUSH_STATE, cb),
});
