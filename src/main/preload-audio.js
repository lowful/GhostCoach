const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioAPI', {
  getDesktopSourceId: () => ipcRenderer.invoke('audio:getSourceId'),
  sendAudioEvent:     (state) => ipcRenderer.send('audio:event', state),
});
