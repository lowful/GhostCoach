'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

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
  // i18n: the catalogue is required here (preloads have Node) and handed to the
  // renderer as a plain translator, so no surface needs Node access to be
  // translated. Read at call time, so a language change repaints correctly.
  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  sendChat: (messages) => ipcRenderer.invoke(C.CHAT_SEND, messages),
  getState: () => ipcRenderer.invoke(C.STATE_GET),
  // Pending session context from the stats dashboard ("Ask Coach about this"),
  // cleared on read so it fires exactly once.
  getSeed:  () => ipcRenderer.invoke(C.CHAT_SEED),
  onState:  (cb) => subscribe(C.PUSH_STATE, cb),
});
