'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

// Display-only badge, just listens for coaching status to pulse appropriately.
contextBridge.exposeInMainWorld('ghost', {
  onStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(C.PUSH_STATUS, handler);
    return () => ipcRenderer.removeListener(C.PUSH_STATUS, handler);
  },
});
