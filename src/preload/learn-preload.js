'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Bridge for the learning surface.
 *
 * The curriculum and the champion roster are required HERE, in the preload,
 * where Node is available, and handed to the renderer as plain data. That is
 * the same move i18n and the games registry already make, and it is why this
 * surface needs no server call and works with no network at all: everything it
 * teaches is in the app.
 */
contextBridge.exposeInMainWorld('occlara', {
  getLearn:    () => ipcRenderer.invoke(C.LEARN_GET),
  setProgress: (lessonId, done) => ipcRenderer.invoke(C.LEARN_PROGRESS, { lessonId, done }),
  close:       () => window.close(),
});
