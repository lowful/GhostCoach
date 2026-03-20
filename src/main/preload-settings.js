const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  saveSettings:   (s)   => ipcRenderer.send('settings:save', s),
  startCoaching:  ()    => ipcRenderer.send('settings:startCoaching'),
  stopCoaching:   ()    => ipcRenderer.send('settings:stopCoaching'),
  pauseResume:    ()    => ipcRenderer.send('settings:pauseResume'),
  forceCapture:   ()    => ipcRenderer.send('settings:forceCapture'),
  forceSummary:   ()    => ipcRenderer.send('settings:forceSummary'),
  quit:           ()    => ipcRenderer.send('settings:quit'),
  onState:  (cb) => ipcRenderer.on('settings:state',  (_, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('settings:status', (_, d) => cb(d)),
});
