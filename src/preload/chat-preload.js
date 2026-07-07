'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Ask Coach bridge: send a conversation turn (optionally with a screenshot of
 * the current screen) and read session state for context chips.
 */
function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ghost', {
  sendChat: (messages, opts) => ipcRenderer.invoke(C.CHAT_SEND, messages, opts || {}),
  getState: () => ipcRenderer.invoke(C.STATE_GET),
  onState:  (cb) => subscribe(C.PUSH_STATE, cb),
});
