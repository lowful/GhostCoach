'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Stats dashboard bridge: read the assembled dashboard, refresh tracker
 * matches (rate limited), and hand a session's context to Ask Coach.
 */
contextBridge.exposeInMainWorld('ghost', {
  getDashboard:    (mode) => ipcRenderer.invoke(C.STATS_DASHBOARD, mode),
  refreshMatches:  (mode) => ipcRenderer.invoke(C.STATS_REFRESH, mode),
  matchesFor:      (mode) => ipcRenderer.invoke(C.STATS_MATCHES, mode),
  openChat:        () => ipcRenderer.send(C.OPEN_CHAT),
  askAboutSession: (seed) => ipcRenderer.send(C.OPEN_CHAT_SEEDED, seed),
});
