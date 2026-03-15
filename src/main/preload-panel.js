const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelAPI', {
  // Outgoing: panel -> main
  startCoaching: () => ipcRenderer.send('panel:start'),
  stopCoaching: () => ipcRenderer.send('panel:stop'),
  setGame: (game) => ipcRenderer.send('panel:setGame', game),
  setInterval: (ms) => ipcRenderer.send('panel:setInterval', ms),
  forceCapture: () => ipcRenderer.send('panel:forceCapture'),
  movePanel: (x, y) => ipcRenderer.send('panel:move', { x, y }),
  minimizePanel: () => ipcRenderer.send('panel:minimize'),

  // Incoming: main -> panel
  onCoachingState: (callback) => ipcRenderer.on('coach:state', (_, data) => callback(data)),
  onTip: (callback) => ipcRenderer.on('coach:tip', (_, data) => callback(data)),
  onStatus: (callback) => ipcRenderer.on('coach:status', (_, data) => callback(data)),
  onSettings: (callback) => ipcRenderer.on('panel:settings', (_, data) => callback(data))
});
