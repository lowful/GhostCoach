(function () {
  'use strict';

  // ─── DOM refs ─────────────────────────────────────────────────────────────────
  const statusDot        = document.getElementById('status-dot');
  const statusText       = document.getElementById('status-text');
  const sessionStats     = document.getElementById('session-stats');
  const statTips         = document.getElementById('stat-tips');
  const statTime         = document.getElementById('stat-time');
  const btnCoach         = document.getElementById('btn-coach');
  const btnPause         = document.getElementById('btn-pause');
  const btnForce         = document.getElementById('btn-force');
  const perfSelect       = document.getElementById('perf-select');
  const overlayPosBtns   = document.querySelectorAll('.overlay-pos-btn');
  const tipPosBtns       = document.querySelectorAll('.tip-pos-btn');
  const btnQuit          = document.getElementById('btn-quit');
  const audioToggle      = document.getElementById('audio-toggle');
  const audioLabel       = document.getElementById('audio-label');
  const licensePlanEl    = document.getElementById('license-plan');
  const licenseStatusEl  = document.getElementById('license-status-badge');
  const licenseExpiryEl  = document.getElementById('license-expiry');
  const usernameInput    = document.getElementById('valorant-username');

  // ─── Local state ──────────────────────────────────────────────────────────────
  let isCoaching       = false;
  let isPaused         = false;
  let tipPosition      = 'bottom-right';
  let overlayPosition  = 'top-left';
  let performanceMode  = 'balanced';
  let audioDetection   = true;
  let sessionStartTime = null;
  let sessionTipCount  = 0;
  let sessionTimerInterval = null;

  // ─── Status map ───────────────────────────────────────────────────────────────
  const STATUS_MAP = {
    idle:             { cls: '',           text: 'Ready' },
    coaching:         { cls: 'coaching',   text: 'Coaching' },
    capturing:        { cls: 'capturing',  text: 'Capturing...' },
    analyzing:        { cls: 'analyzing',  text: 'Analyzing...' },
    summarizing:      { cls: 'analyzing',  text: 'Generating summary...' },
    paused:           { cls: 'paused',     text: 'Paused' },
    stopped:          { cls: '',           text: 'Stopped' },
    connection_lost:  { cls: 'connection', text: 'Connection lost...' },
    rate_limited:     { cls: 'rate',       text: 'Rate limited' },
    error:            { cls: 'error',      text: 'Error' }
  };

  function setStatus(key, customText) {
    const s = STATUS_MAP[key] || STATUS_MAP.idle;
    statusDot.className = 'sdot ' + s.cls;
    statusText.textContent = customText || s.text;
  }

  // ─── Coaching state ───────────────────────────────────────────────────────────
  function setCoachingUI(active) {
    isCoaching = active;
    btnCoach.classList.toggle('active', active);
    btnCoach.textContent = active ? 'STOP COACHING' : 'START COACHING';
    btnPause.classList.toggle('hidden', !active);

    if (active) {
      setStatus('coaching', 'Coaching');
      sessionStats.classList.remove('hidden');
      startSessionTimer();
    } else {
      setStatus('idle', 'Ready');
      sessionStats.classList.add('hidden');
      stopSessionTimer();
    }
  }

  // ─── Session timer ────────────────────────────────────────────────────────────
  function startSessionTimer() {
    stopSessionTimer();
    if (!sessionStartTime) sessionStartTime = Date.now();
    sessionTimerInterval = setInterval(updateSessionStats, 15000);
    updateSessionStats();
  }

  function stopSessionTimer() {
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }
  }

  function updateSessionStats() {
    statTips.textContent = 'Tips: ' + sessionTipCount;
    if (sessionStartTime) {
      const mins = Math.floor((Date.now() - sessionStartTime) / 60000);
      statTime.textContent = mins + 'm';
    }
  }

  // ─── Position button highlighters ─────────────────────────────────────────────
  function updateOverlayPosBtns() {
    overlayPosBtns.forEach(b => b.classList.toggle('active', b.dataset.pos === overlayPosition));
  }

  function updateTipPosBtns() {
    tipPosBtns.forEach(b => b.classList.toggle('active', b.dataset.pos === tipPosition));
  }

  // ─── Audio toggle ─────────────────────────────────────────────────────────────
  function setAudioToggle(enabled) {
    audioDetection = !!enabled;
    audioToggle.dataset.on = audioDetection ? 'true' : 'false';
    audioLabel.textContent = audioDetection ? 'Enabled' : 'Disabled';
  }

  // ─── License display ──────────────────────────────────────────────────────────
  function updateLicenseDisplay(state) {
    if (!state.licenseStatus) return;

    if (licensePlanEl && state.licensePlan) {
      licensePlanEl.textContent = state.licensePlan.toUpperCase() || 'GHOSTCOACH';
    }

    if (licenseStatusEl) {
      licenseStatusEl.textContent = (state.licenseStatus || '').toUpperCase();
      licenseStatusEl.className = 'license-badge ' +
        (state.licenseStatus === 'active' ? 'badge-active' : 'badge-warn');
      licenseStatusEl.classList.remove('hidden');
    }

    if (licenseExpiryEl && state.licenseExpiry) {
      const d = new Date(state.licenseExpiry);
      if (!isNaN(d)) {
        licenseExpiryEl.textContent = 'Renews ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        licenseExpiryEl.classList.remove('hidden');
      }
    }
  }

  // ─── Save settings ────────────────────────────────────────────────────────────
  function saveSettings(patch) {
    if (!window.settingsAPI) return;
    window.settingsAPI.saveSettings(Object.assign({
      tipPos: tipPosition,
      overlayPosition,
      performanceMode,
      audioDetection,
      valorantUsername: usernameInput ? usernameInput.value.trim() : '',
    }, patch));
  }

  // ─── Button handlers ──────────────────────────────────────────────────────────
  btnCoach.addEventListener('click', () => {
    if (!window.settingsAPI) return;
    if (isCoaching) window.settingsAPI.stopCoaching();
    else            window.settingsAPI.startCoaching();
  });

  btnPause.addEventListener('click', () => {
    if (!window.settingsAPI) return;
    window.settingsAPI.pauseResume();
    isPaused = !isPaused;
    btnPause.textContent = isPaused ? '▶' : '⏸';
    btnPause.title = isPaused ? 'Resume coaching (Ctrl+Shift+P)' : 'Pause coaching (Ctrl+Shift+P)';
  });

  btnForce.addEventListener('click', () => {
    if (!window.settingsAPI) return;
    window.settingsAPI.forceCapture();
    setStatus('capturing', 'Capturing...');
  });

  perfSelect.addEventListener('change', () => {
    performanceMode = perfSelect.value;
    saveSettings();
  });

  overlayPosBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      overlayPosition = btn.dataset.pos;
      updateOverlayPosBtns();
      saveSettings();
    });
  });

  tipPosBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tipPosition = btn.dataset.pos;
      updateTipPosBtns();
      saveSettings();
    });
  });

  // Audio toggle click
  [audioToggle, audioLabel].forEach(el => {
    el.addEventListener('click', () => {
      setAudioToggle(!audioDetection);
      saveSettings();
    });
  });

  // ─── Valorant username ────────────────────────────────────────────────────────
  if (usernameInput) {
    let usernameTimer = null;
    usernameInput.addEventListener('input', () => {
      clearTimeout(usernameTimer);
      usernameTimer = setTimeout(() => saveSettings(), 1000);
    });
  }

  // ─── Quit ─────────────────────────────────────────────────────────────────────
  btnQuit.addEventListener('click', () => {
    if (!window.settingsAPI) return;
    window.settingsAPI.quit();
  });

  // ─── IPC listeners ────────────────────────────────────────────────────────────
  if (window.settingsAPI) {

    window.settingsAPI.onState((state) => {
      setCoachingUI(!!state.isCoaching);

      if (state.isPaused !== undefined) {
        isPaused = state.isPaused;
        btnPause.textContent = isPaused ? '▶' : '⏸';
      }
      if (state.performanceMode) {
        performanceMode = state.performanceMode;
        perfSelect.value = state.performanceMode;
      }
      if (state.tipPos) {
        tipPosition = state.tipPos;
        updateTipPosBtns();
      }
      if (state.overlayPosition) {
        overlayPosition = state.overlayPosition;
        updateOverlayPosBtns();
      }
      if (state.tipCount !== undefined) {
        sessionTipCount = state.tipCount;
        updateSessionStats();
      }
      if (state.sessionStart) {
        sessionStartTime = state.sessionStart;
        updateSessionStats();
      } else if (!state.isCoaching) {
        sessionStartTime = null;
      }
      if (state.audioDetection !== undefined) {
        setAudioToggle(state.audioDetection);
      }
      if (state.valorantUsername !== undefined && usernameInput && !usernameInput.value) {
        usernameInput.value = state.valorantUsername;
      }
      updateLicenseDisplay(state);
    });

    window.settingsAPI.onStatus((data) => {
      setStatus(data.status, data.message);

      if (data.status === 'paused') {
        isPaused = true;
        if (btnPause) { btnPause.textContent = '▶'; btnPause.title = 'Resume coaching'; }
      } else if (data.status === 'coaching' && isPaused) {
        isPaused = false;
        if (btnPause) { btnPause.textContent = '⏸'; btnPause.title = 'Pause coaching'; }
      }
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  updateOverlayPosBtns();
  updateTipPosBtns();

})();
