const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
  saveApiKey: (key) => ipcRenderer.send('setup:saveKey', key),
  openExternal: (url) => ipcRenderer.send('setup:openExternal', url),
  onReady: (callback) => ipcRenderer.on('setup:ready', (_, data) => callback(data))
});
