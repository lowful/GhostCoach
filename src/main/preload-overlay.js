const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  doClose:            () => ipcRenderer.send('overlay:doClose'),
  completeOnboarding: () => ipcRenderer.send('overlay:completeOnboarding'),
  resetOnboarding:    () => ipcRenderer.send('overlay:resetOnboarding'),
  setInteractive:     (v) => ipcRenderer.send('overlay:setInteractive', v),

  // ── Inbound: main → renderer ──────────────────────────────────────────────────
  onTip:          (cb) => ipcRenderer.on('coach:tip',           (_, d) => cb(d)),
  onRoundSummary: (cb) => ipcRenderer.on('coach:roundSummary',  (_, d) => cb(d)),
  onMatchSummary: (cb) => ipcRenderer.on('coach:matchSummary',  (_, d) => cb(d)),
  onSessionOver:  (cb) => ipcRenderer.on('coach:sessionOver',   (_, d) => cb(d)),
  onState:        (cb) => ipcRenderer.on('coach:state',         (_, d) => cb(d)),
  onStatus:       (cb) => ipcRenderer.on('coach:status',        (_, d) => cb(d)),
  onVisibility:   (cb) => ipcRenderer.on('overlay:visibility',  (_, d) => cb(d)),
  onMatchState:   (cb) => ipcRenderer.on('coach:matchState',    (_, d) => cb(d)),
  onPlayerState:  (cb) => ipcRenderer.on('coach:playerState',   (_, d) => cb(d)),
  onPauseState:   (cb) => ipcRenderer.on('coach:pauseState',    (_, d) => cb(d)),
  onTrayToggle:   (cb) => ipcRenderer.on('tray:toggleCoaching', ()     => cb()),
  onMinimize:       (cb) => ipcRenderer.on('overlay:minimize',       (_, d) => cb(d)),
  onMiniToast:      (cb) => ipcRenderer.on('overlay:miniToast',      (_, d) => cb(d)),
  onRecap:          (cb) => ipcRenderer.on('coach:recap',             (_, d) => cb(d)),
  onToggleHistory:  (cb) => ipcRenderer.on('overlay:toggleHistory',   ()     => cb())
});
