'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');
const I18N = require('../shared/i18n');

/**
 * History bridge, pull the current tip list and stay live as new tips arrive.
 */
function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('occlara', {
  // i18n: the catalogue is required here (preloads have Node) and handed to the
  // renderer as a plain translator, so no surface needs Node access to be
  // translated. Read at call time, so a language change repaints correctly.
  i18n: {
    languages: () => I18N.LANGUAGES,
    t: (code, key) => I18N.t(code, key),
    hasUi: (code) => I18N.hasUi(code),
  },

  getState:     () => ipcRenderer.invoke(C.STATE_GET),
  listSessions: () => ipcRenderer.invoke(C.SESSIONS_LIST),
  getSession:   (file) => ipcRenderer.invoke(C.SESSION_GET, file),
  rateTip:      (payload) => ipcRenderer.send(C.TIP_RATE, payload),
  onTip:        (cb) => subscribe(C.PUSH_TIP, cb),
  onState:      (cb) => subscribe(C.PUSH_STATE, cb),

  // Jumping from a session's tips to the frames those tips were written from.
  // Metadata only: aiLogSessions never reads a frame, so filling this in costs
  // a few hundred bytes rather than the tens of megabytes the full log is.
  aiLogSessions: () => ipcRenderer.invoke(C.AILOG_SESSIONS),
  openAiLog:     (sessionId) => ipcRenderer.send(C.OPEN_AILOG, sessionId || null),
});
