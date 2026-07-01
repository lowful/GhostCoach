'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Activation bridge, submit a license key and open the purchase page.
 */
contextBridge.exposeInMainWorld('ghost', {
  activate:     (key) => ipcRenderer.invoke(C.LICENSE_ACTIVATE, key),
  openPurchase: () => ipcRenderer.send(C.OPEN_PURCHASE),
  quit:         () => ipcRenderer.send(C.APP_QUIT),
});
