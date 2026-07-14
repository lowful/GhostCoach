'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/** Game-audio listener bridge: pushes rolling WAV clips (base64) to main. */
contextBridge.exposeInMainWorld('ghost', {
  pushClip: (wavB64) => ipcRenderer.send(C.AUDIO_CLIP, wavB64),
});
