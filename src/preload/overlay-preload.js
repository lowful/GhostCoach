'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const C = require('../shared/channels');

/**
 * Overlay bridge, display-only. Receives pushes from main, sends nothing back.
 * Subscriptions return an unsubscribe fn (old client leaked listeners by
 * re-registering on every state update).
 */
function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ghost', {
  onTip:        (cb) => subscribe(C.PUSH_TIP, cb),
  onStatus:     (cb) => subscribe(C.PUSH_STATUS, cb),
  onState:      (cb) => subscribe(C.PUSH_STATE, cb),
  onMatchReview:(cb) => subscribe(C.PUSH_MATCH_REVIEW, cb),
  onVisibility: (cb) => subscribe(C.PUSH_OVERLAY_VIS, cb),
  // The overlay is click-through; while the cursor hovers the review card this
  // asks main to accept mouse input so its ✕ can actually be clicked.
  setInteractive: (on) => ipcRenderer.send(C.OVERLAY_INTERACT, !!on),
});
