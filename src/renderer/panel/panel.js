(function () {
  // ─── Elements ───────────────────────────────────────────────────────────────
  const panel         = document.getElementById('panel');
  const titlebar      = document.getElementById('titlebar');
  const btnCollapse   = document.getElementById('btn-collapse');
  const btnSettings   = document.getElementById('btn-settings');
  const btnCoach      = document.getElementById('btn-coach');
  const btnCoachLabel = document.getElementById('btn-coach-label');
  const btnForce      = document.getElementById('btn-force');
  const gameSelect    = document.getElementById('game-select');
  const statusDot     = document.getElementById('status-dot');
  const statusText    = document.getElementById('status-text');
  const tipPreview    = document.getElementById('tip-preview');
  const tipPreviewText= document.getElementById('tip-preview-text');
  const settingsPanel = document.getElementById('settings-panel');
  const historyPanel  = document.getElementById('history-panel');
  const historyList   = document.getElementById('history-list');
  const intervalDisplay = document.getElementById('interval-display');
  const btnIntervalDec  = document.getElementById('btn-interval-dec');
  const btnIntervalInc  = document.getElementById('btn-interval-inc');

  // ─── State ──────────────────────────────────────────────────────────────────
  let isCoaching = false;
  let isExpanded = true;
  let showSettings = false;
  let intervalMs = 8000;
  let tipHistory = [];

  // ─── Dragging ────────────────────────────────────────────────────────────────
  let dragging = false;
  let dragStartX = 0, dragStartY = 0;
  let winStartX = 0, winStartY = 0;

  titlebar.addEventListener('mousedown', (e) => {
    if (e.target !== titlebar && !e.target.classList.contains('logo-icon') &&
        !e.target.classList.contains('logo-text') && e.target.id !== 'logo') return;

    dragging = true;
    dragStartX = e.screenX;
    dragStartY = e.screenY;

    const pos = window.screenX !== undefined
      ? { x: window.screenX, y: window.screenY }
      : { x: 20, y: 20 };
    winStartX = pos.x;
    winStartY = pos.y;
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - dragStartX;
    const dy = e.screenY - dragStartY;
    const newX = winStartX + dx;
    const newY = winStartY + dy;
    window.panelAPI.movePanel(newX, newY);
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
  });

  // ─── Collapse ────────────────────────────────────────────────────────────────
  btnCollapse.addEventListener('click', () => {
    isExpanded = !isExpanded;
    panel.classList.toggle('collapsed', !isExpanded);
    btnCollapse.textContent = isExpanded ? '▲' : '▼';

    if (!isExpanded) {
      settingsPanel.classList.add('hidden');
      historyPanel.classList.add('hidden');
      showSettings = false;
    }
  });

  // ─── Settings toggle ─────────────────────────────────────────────────────────
  btnSettings.addEventListener('click', () => {
    showSettings = !showSettings;

    if (showSettings) {
      settingsPanel.classList.remove('hidden');
      historyPanel.classList.add('hidden');
      btnSettings.style.color = '#00F0FF';
    } else {
      settingsPanel.classList.add('hidden');
      historyPanel.classList.add('hidden');
      btnSettings.style.color = '';
    }
  });

  // ─── Game select ─────────────────────────────────────────────────────────────
  gameSelect.addEventListener('change', () => {
    window.panelAPI.setGame(gameSelect.value);
  });

  // ─── Coach button ─────────────────────────────────────────────────────────────
  btnCoach.addEventListener('click', () => {
    if (isCoaching) {
      window.panelAPI.stopCoaching();
    } else {
      window.panelAPI.startCoaching();
    }
  });

  // ─── Force capture ────────────────────────────────────────────────────────────
  btnForce.addEventListener('click', () => {
    window.panelAPI.forceCapture();
    setStatus('capturing');
  });

  // ─── Interval controls ───────────────────────────────────────────────────────
  const INTERVAL_STEPS = [5000, 8000, 10000, 15000, 20000, 30000];

  function updateIntervalDisplay() {
    intervalDisplay.textContent = (intervalMs / 1000) + 's';
  }

  btnIntervalDec.addEventListener('click', () => {
    const idx = INTERVAL_STEPS.indexOf(intervalMs);
    if (idx > 0) {
      intervalMs = INTERVAL_STEPS[idx - 1];
      updateIntervalDisplay();
      window.panelAPI.setInterval(intervalMs);
    }
  });

  btnIntervalInc.addEventListener('click', () => {
    const idx = INTERVAL_STEPS.indexOf(intervalMs);
    if (idx < INTERVAL_STEPS.length - 1) {
      intervalMs = INTERVAL_STEPS[idx + 1];
      updateIntervalDisplay();
      window.panelAPI.setInterval(intervalMs);
    }
  });

  // ─── Status updates ──────────────────────────────────────────────────────────
  const STATUS_MAP = {
    idle:      { dot: 'dot-idle',      text: 'Ready' },
    capturing: { dot: 'dot-analyzing', text: 'Capturing screen…' },
    analyzing: { dot: 'dot-analyzing', text: 'Analyzing…' },
    waiting:   { dot: 'dot-idle',      text: 'Waiting for game…' },
    stopped:   { dot: 'dot-idle',      text: 'Stopped' },
    error:     { dot: 'dot-error',     text: 'Error' }
  };

  function setStatus(status, message) {
    const s = STATUS_MAP[status] || STATUS_MAP.idle;
    statusDot.className = s.dot;
    statusText.textContent = message || s.text;
  }

  function setCoachingState(active) {
    isCoaching = active;
    btnCoach.classList.toggle('active', active);
    btnCoachLabel.textContent = active ? 'STOP COACHING' : 'START COACHING';
    const dot = btnCoach.querySelector('.btn-dot');
    if (active) {
      dot.style.background = '#ff6060';
      setStatus('capturing');
    } else {
      dot.style.background = '#00F0FF';
      setStatus('idle');
    }
  }

  // ─── Tip history ─────────────────────────────────────────────────────────────
  function renderHistory(history) {
    tipHistory = history || [];
    historyList.innerHTML = '';

    if (tipHistory.length === 0) {
      historyList.innerHTML = '<div style="font-size:11px;color:rgba(180,200,210,0.4);padding:6px 0;">No tips yet.</div>';
      return;
    }

    tipHistory.forEach(tip => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const ts = new Date(tip.timestamp);
      const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      item.innerHTML = `
        <div class="history-item-text">${escapeHtml(tip.text)}</div>
        <div class="history-item-meta">${escapeHtml(tip.game)} · ${timeStr}</div>
      `;
      historyList.appendChild(item);
    });
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── IPC Listeners ───────────────────────────────────────────────────────────
  if (window.panelAPI) {
    window.panelAPI.onCoachingState((state) => {
      setCoachingState(state.isCoaching);
      if (state.game) gameSelect.value = state.game;
      if (state.interval) {
        intervalMs = state.interval;
        updateIntervalDisplay();
      }
      if (state.history) renderHistory(state.history);
    });

    window.panelAPI.onTip((data) => {
      // Show latest tip in preview
      tipPreview.classList.remove('hidden');
      tipPreviewText.textContent = data.text;

      if (data.history) renderHistory(data.history);
    });

    window.panelAPI.onStatus((data) => {
      if (isCoaching || data.status === 'error') {
        setStatus(data.status, data.message);
      }
    });

    window.panelAPI.onSettings((data) => {
      if (data.game) gameSelect.value = data.game;
      if (data.interval) {
        intervalMs = data.interval;
        updateIntervalDisplay();
      }
    });
  }

  // ─── Init ────────────────────────────────────────────────────────────────────
  updateIntervalDisplay();
})();
