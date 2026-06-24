const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onShowTip: (callback) => ipcRenderer.on('show-tip', (event, tip) => callback(tip)),
  onCoachingStatus: (callback) => ipcRenderer.on('coaching-status', (event, status) => callback(status)),
  onMatchReview: (callback) => ipcRenderer.on('match-review', (event, review) => callback(review)),
  onTipPosition: (callback) => ipcRenderer.on('tip-position', (event, pos) => callback(pos)),
  onOverlayPosition: (callback) => ipcRenderer.on('overlay-position', (event, pos) => callback(pos)),
  getConfig: () => ipcRenderer.invoke('get-config'),
  startCoaching: () => ipcRenderer.invoke('start-coaching'),
  stopCoaching: () => ipcRenderer.invoke('stop-coaching'),
  requestTip: () => ipcRenderer.invoke('request-tip')
});