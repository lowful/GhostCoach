(function () {
  'use strict';

  // ─── DOM refs ─────────────────────────────────────────────────────────────────
  const statusDot       = document.getElementById('status-dot');
  const statusText      = document.getElementById('status-text');
  const sessionStats    = document.getElementById('session-stats');
  const statTips        = document.getElementById('stat-tips');
  const statTime        = document.getElementById('stat-time');
  const btnCoach        = document.getElementById('btn-coach');
  const btnPause        = document.getElementById('btn-pause');
  const btnForce        = document.getElementById('btn-force');
  const modeSelect      = document.getElementById('mode-select');
  const perfSelect      = document.getElementById('perf-select');
  const posBtns         = document.querySelectorAll('.pos-btn');
  const btnContinueDead = document.getElementById('btn-continue-dead');
  const deadLabel       = document.getElementById('dead-label');
  const apiKeyInput     = document.getElementById('api-key-input');
  const btnShowKey      = document.getElementById('btn-show-key');
  const btnSaveKey      = document.getElementById('btn-save-key');
  const btnQuit         = document.getElementById('btn-quit');

  // ─── Local state ──────────────────────────────────────────────────────────────
  let isCoaching       = false;
  let isPaused         = false;
  let tipPosition      = 'top-right';
  let coachingMode     = 'smart';
  let performanceMode  = 'balanced';
  let continueWhileDead = false;
  let sessionStartTime = null;
  let sessionTipCount  = 0;
  let sessionTimerInterval = null;

  // ─── Status map ───────────────────────────────────────────────────────────────
  const STATUS_MAP = {
    idle:             { cls: '',           text: 'Ready' },
    coaching:         { cls: 'coaching',   text: 'Coaching' },
    capturing:        { cls: 'capturing',  text: 'Capturing...' },
    analyzing:        { cls: 'analyzing',  text: 'Analyzing...' },
    detecting:        { cls: 'analyzing',  text: 'Detecting match...' },
    summarizing:      { cls: 'analyzing',  text: 'Generating summary...' },
    waiting_for_match:{ cls: 'waiting',    text: 'Waiting for match...' },
    active_combat:    { cls: 'combat',     text: 'In combat' },
    player_dead:      { cls: 'dead',       text: 'Player dead' },
    round_end:        { cls: 'coaching',   text: 'Round ended' },
    paused:           { cls: 'paused',     text: 'Paused' },
    stopped:          { cls: '',           text: 'Stopped' },
    connection_lost:  { cls: 'connection', text: 'Connection lost...' },
    rate_limited:     { cls: 'rate',       text: 'Rate limited' },
    auth_error:       { cls: 'error',      text: 'API key error' },
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

  // ─── Position buttons ─────────────────────────────────────────────────────────
  function updatePosButtons() {
    posBtns.forEach(b => b.classList.toggle('active', b.dataset.pos === tipPosition));
  }

  // ─── Save settings ────────────────────────────────────────────────────────────
  function saveSettings() {
    if (!window.settingsAPI) return;
    window.settingsAPI.saveSettings({
      mode:             coachingMode,
      tipPos:           tipPosition,
      performanceMode,
      continueWhileDead
    });
  }

  // ─── Button handlers ──────────────────────────────────────────────────────────
  btnCoach.addEventListener('click', () => {
    if (!window.settingsAPI) return;
    if (isCoaching) {
      window.settingsAPI.stopCoaching();
    } else {
      window.settingsAPI.startCoaching();
    }
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

  modeSelect.addEventListener('change', () => {
    coachingMode = modeSelect.value;
    saveSettings();
  });

  perfSelect.addEventListener('change', () => {
    performanceMode = perfSelect.value;
    saveSettings();
  });

  posBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tipPosition = btn.dataset.pos;
      updatePosButtons();
      saveSettings();
    });
  });

  btnContinueDead.addEventListener('click', () => {
    continueWhileDead = !continueWhileDead;
    btnContinueDead.dataset.on = continueWhileDead.toString();
    deadLabel.textContent = continueWhileDead ? 'Coach' : 'Pause';
    saveSettings();
  });

  // ─── API Key ──────────────────────────────────────────────────────────────────
  let keyVisible = false;

  btnShowKey.addEventListener('click', () => {
    keyVisible = !keyVisible;
    apiKeyInput.type = keyVisible ? 'text' : 'password';
    btnShowKey.textContent = keyVisible ? '🙈' : '👁';
  });

  apiKeyInput.addEventListener('input', () => {
    const val = apiKeyInput.value.trim();
    btnSaveKey.disabled = val.length < 20 || !val.startsWith('sk-');
  });

  btnSaveKey.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (key.length < 20) return;
    if (!window.settingsAPI) return;
    window.settingsAPI.updateApiKey(key);
    btnSaveKey.disabled = true;
    btnSaveKey.textContent = 'SAVED!';
    setTimeout(() => { btnSaveKey.textContent = 'UPDATE KEY'; }, 2000);
  });

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
      if (state.mode) {
        coachingMode = state.mode;
        modeSelect.value = state.mode;
      }
      if (state.performanceMode) {
        performanceMode = state.performanceMode;
        perfSelect.value = state.performanceMode;
      }
      if (state.tipPos) {
        tipPosition = state.tipPos;
        updatePosButtons();
      }
      if (typeof state.continueWhileDead === 'boolean') {
        continueWhileDead = state.continueWhileDead;
        btnContinueDead.dataset.on = continueWhileDead.toString();
        deadLabel.textContent = continueWhileDead ? 'Coach' : 'Pause';
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
    });

    window.settingsAPI.onStatus((data) => {
      setStatus(data.status, data.message);

      // Sync pause button on pause state change
      if (data.status === 'paused') {
        isPaused = true;
        if (btnPause) { btnPause.textContent = '▶'; btnPause.title = 'Resume coaching'; }
      } else if (data.status === 'coaching' && isPaused) {
        isPaused = false;
        if (btnPause) { btnPause.textContent = '⏸'; btnPause.title = 'Pause coaching'; }
      }
    });
  }

})();
