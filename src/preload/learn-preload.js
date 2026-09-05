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
  // Returns the whole recomputed payload, because changing band or role changes
  // which skills apply and what every target is.
  setProfile:  (band, role) => ipcRenderer.invoke(C.LEARN_PROFILE, { band, role }),
  close:       () => window.close(),
});
