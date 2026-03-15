const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('activateAPI', {
  validateKey:   (key) => ipcRenderer.invoke('activate:validateKey', key),
  openPurchase:  ()    => ipcRenderer.send('activate:openPurchase'),
  quit:          ()    => ipcRenderer.send('activate:quit'),
});
