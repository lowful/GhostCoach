(function () {
  'use strict';

  // ─── DOM refs ─────────────────────────────────────────────────────────────────
  const overlayHiddenIndicator = document.getElementById('overlay-hidden-indicator');
  const panel          = document.getElementById('panel');
  const panelMini      = document.getElementById('panel-mini');
  const miniStatusDot  = document.getElementById('mini-status-dot');
  const miniToast      = document.getElementById('mini-toast');
  const statusDot      = document.getElementById('status-dot');
  const statusText     = document.getElementById('status-text');
  const sessionStats   = document.getElementById('session-stats');
  const statTips       = document.getElementById('stat-tips');
  const statTime       = document.getElementById('stat-time');
  const statPerf       = document.getElementById('stat-perf');
  const tipPreview     = document.getElementById('tip-preview');
  const tipPreviewText = document.getElementById('tip-preview-text');
  const hudTips        = document.getElementById('hud-tips');
  const roundSummary   = document.getElementById('round-summary');
  const rsBadge        = document.getElementById('rs-result');
  const rsGood         = document.getElementById('rs-good');
  const rsImprove      = document.getElementById('rs-improve');
  const rsNextTip      = document.getElementById('rs-nexttip-text');
  const rsStars        = document.getElementById('rs-stars');
  const rsTimerFill    = document.getElementById('rs-timer-fill');
  const matchSummary   = document.getElementById('match-summary');
  const msResult       = document.getElementById('ms-result');
  const msRatingCircle = document.getElementById('ms-rating-circle');
  const msRatingNum    = document.getElementById('ms-rating-num');
  const msTipsCount    = document.getElementById('ms-tips-count');
  const msStrengths    = document.getElementById('ms-strengths');
  const msWeaknesses   = document.getElementById('ms-weaknesses');
  const msFocusTip     = document.getElementById('ms-focus-tip');
  const msAutoBarFill  = document.getElementById('ms-auto-bar-fill');
  const sessionOverCard = document.getElementById('session-over-card');
  const soTips         = document.getElementById('so-tips');
  const soTime         = document.getElementById('so-time');

  // ─── State ────────────────────────────────────────────────────────────────────
  let isCoaching       = false;
  let isPaused         = false;
  let tipPosition      = 'bottom-right';
  let overlayPosition  = 'top-left';
  let performanceMode  = 'balanced';
  let sessionStartTime = null;
  let sessionTipCount  = 0;
  let sessionTimerInterval = null;

  // Fix 3: Hidden tip buffer
  let overlayHidden    = false;
  let hiddenTipBuffer  = [];

  // FIX 2: Minimize state
  let isPanelMinimized = false;
  let miniToastTimer   = null;

  // Tip history (last 30 tips + recaps)
  const displayHistory = [];
  let historyVisible   = false;
  const tipHistory     = document.getElementById('tip-history');
  const thList         = document.getElementById('th-list');

  // Active tip cards — max 1 at a time
  const activeTips     = [];
  const TIP_DURATION   = 8000;   // 8s for normal tips
  const RECAP_DURATION = 12000;  // 12s for round recap cards

  // Round summary timer
  let summaryTimer     = null;
  // Match summary timer
  let matchSummaryTimer = null;

  // ─── Status ───────────────────────────────────────────────────────────────────
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

  // Mini dot maps status class → dot variant
  const MINI_DOT_MAP = {
    coaching: 'coaching', capturing: 'coaching', analyzing: 'coaching',
    paused: 'paused', error: 'error', connection: 'error', auth_error: 'error',
    waiting: 'waiting', combat: 'coaching', dead: 'paused'
  };

  function setStatus(key, customText) {
    const s = STATUS_MAP[key] || STATUS_MAP.idle;
    statusDot.className = 'sdot ' + s.cls;
    statusText.textContent = customText || s.text;
    if (miniStatusDot) {
      const dotCls = MINI_DOT_MAP[s.cls] || '';
      miniStatusDot.className = 'mini-dot' + (dotCls ? ' ' + dotCls : '');
    }
  }

  // ─── Session stats ────────────────────────────────────────────────────────────
  function updatePerfIndicator() {
    statPerf.className = 'perf-dot perf-' + performanceMode;
  }

  function updateSessionStats() {
    statTips.textContent = 'Tips: ' + sessionTipCount;
    if (sessionStartTime) {
      const mins = Math.floor((Date.now() - sessionStartTime) / 60000);
      statTime.textContent = mins + 'm';
    }
    updatePerfIndicator();
  }

  function startSessionTimer() {
    stopSessionTimer();
    sessionTimerInterval = setInterval(updateSessionStats, 60000);
    updateSessionStats();
  }

  function stopSessionTimer() {
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }
  }

  // ─── Category detection ───────────────────────────────────────────────────────
  const CATEGORIES = {
    economy:    { kw: /\b(buy|save|credit|eco|force buy|light buy|full buy|rifle|pistol|armor|shield|gold|item|spend|shop|cost|spectre|vandal|phantom)\b/i,  label: 'ECONOMY',     cls: 'cat-economy' },
    positioning:{ kw: /\b(angle|position|peek|hold|corner|site|plant|defuse|crouch|spot|cover|doorway|boost|lineup|off-angle|retake)\b/i,                     label: 'POSITIONING', cls: 'cat-positioning' },
    ability:    { kw: /\b(ult|ultimate|ability|smoke|flash|molly|grenade|wall|dash|blind|spell|cooldown|utility|kit|sage|sova|omen|recon)\b/i,                label: 'ABILITY',     cls: 'cat-ability' },
    rotation:   { kw: /\b(rotate|rotation|flank|push|rush|retake|split|lurk|roam|back|side|macro|objective|mid|a site|b site)\b/i,                           label: 'ROTATION',    cls: 'cat-rotation' }
  };

  function detectCategory(text) {
    for (const [, def] of Object.entries(CATEGORIES)) {
      if (def.kw.test(text)) return { label: def.label, cls: def.cls };
    }
    return { label: 'TIP', cls: '' };
  }

  // ─── Filter — skip non-gameplay responses ────────────────────────────────────
  function shouldSkipResponse(text) {
    if (!text || text.trim().length < 20) return true;
    const t = text.trim().toUpperCase();
    if (t === 'SKIP' || t === 'VICTORY' || t === 'DEFEAT') return true;
    return false;
  }

  // ─── Clean tip text ───────────────────────────────────────────────────────────
  function cleanTipText(text) {
    return text
      .replace(/[\u2014\u2013\u2012\u2015]/g, ',') // em-dash, en-dash → comma
      .replace(/ - /g, ', ')
      .trim()
      .slice(0, 100);
  }

  // ─── Tip history helpers ──────────────────────────────────────────────────────
  function addToHistory(text, isRecap, isLibrary, timestamp) {
    displayHistory.unshift({ text, isRecap, isLibrary: !!isLibrary, timestamp: timestamp || Date.now() });
    if (displayHistory.length > 40) displayHistory.pop();
    renderHistory();
  }

  setInterval(renderHistory, 60000); // keep relative timestamps live

  function renderHistory() {
    if (!thList) return;
    const now        = Date.now();
    const TWENTY_MIN = 20 * 60 * 1000;
    const recent     = displayHistory.filter(e => now - e.timestamp < TWENTY_MIN);

    thList.innerHTML = '';
    recent.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'th-item';

      const ago     = Math.floor((now - entry.timestamp) / 60000);
      const timeStr = ago < 1 ? 'now' : ago + 'm ago';

      let badge = '';
      if (entry.isRecap)        badge = '<span class="th-badge-recap">RECAP</span>';
      else if (entry.isLibrary) badge = '<span class="th-badge-lib">LIB</span>';
      else                      badge = '<span class="th-badge-ai">AI</span>';

      item.innerHTML =
        `<div class="th-item-meta">` +
          `<span class="th-time">${escHtml(timeStr)}</span>` +
          badge +
        `</div>` +
        `<span class="th-item-text">${escHtml(entry.text)}</span>`;

      thList.appendChild(item);
    });
  }

  // ─── Tip display (#tip-container) ────────────────────────────────────────────

  function showTipCard(text, source, category) {
    const container = document.getElementById('tip-container');
    if (!container) {
      console.error('[overlay] tip-container not found!');
      return;
    }

    // Update panel preview
    if (tipPreview && tipPreviewText) {
      tipPreview.classList.remove('hidden');
      tipPreviewText.textContent = text.length > 30 ? text.slice(0, 30) + '\u2026' : text;
    }

    sessionTipCount++;
    updateSessionStats();
    addToHistory(text, false, source === 'library');

    const isAI         = source === 'ai';
    const isSystem     = source === 'system';
    const isMotivation = category === 'motivation' || category === 'hype';
    const borderColor  = isAI ? '#00F0FF' : isSystem ? 'rgba(236,232,225,0.3)' : isMotivation ? '#FFB800' : '#FF4655';
    const badgeColor   = isAI ? '#00F0FF' : isSystem ? 'rgba(236,232,225,0.4)' : isMotivation ? '#FFB800' : 'rgba(236,232,225,0.5)';
    const badgeText    = isAI ? 'AI TIP'  : isSystem ? 'GHOSTCOACH' : isMotivation ? (category === 'hype' ? 'HYPE' : 'MENTAL') : 'TIP';

    // Remove existing card
    container.innerHTML = '';

    const card = document.createElement('div');
    card.className  = 'tip-card';
    card.style.cssText = [
      'background:rgba(15,20,30,0.92)',
      'border-radius:10px',
      `border-left:3px solid ${borderColor}`,
      'padding:12px 16px',
      'max-width:380px',
      'opacity:0',
      'transition:opacity 0.3s ease',
      'pointer-events:none',
    ].join(';');

    const badge = document.createElement('div');
    badge.style.cssText = `font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;color:${badgeColor};`;
    badge.textContent = badgeText;

    const tipText = document.createElement('div');
    tipText.style.cssText = 'font-size:14px;color:#ECE8E1;line-height:1.5;font-family:Inter,Arial,sans-serif;';
    tipText.textContent = text;

    card.appendChild(badge);
    card.appendChild(tipText);
    container.appendChild(card);

    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { card.style.opacity = '1'; });
    });

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      card.style.opacity = '0';
      setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 300);
    }, TIP_DURATION);
  }

  // Legacy wrapper so old coach:tip events still work if any remain
  function showTip(data) {
    const text = cleanTipText((data.text || '').trim());
    if (shouldSkipResponse(text)) return;
    const source   = data.isLibrary ? 'library' : 'ai';
    const category = data.isMotivational ? 'motivation' : 'general';
    showTipCard(text, source, category);
  }

  function showRecap(data) {
    const raw = (data.recap || data.text || '').trim();
    if (!raw || raw.length < 8) return;
    showTipCard(cleanTipText(raw), 'library', 'general');
  }

  // ─── Round summary ────────────────────────────────────────────────────────────
  function showRoundSummary(data) {
    if (summaryTimer) clearTimeout(summaryTimer);

    const res = (data.round_result || 'unknown').toLowerCase();
    rsBadge.textContent = res === 'win' ? 'WIN' : res === 'loss' ? 'LOSS' : '—';
    rsBadge.className   = 'rs-badge ' + (res === 'win' ? 'win' : res === 'loss' ? 'loss' : '');

    rsGood.innerHTML = '';
    (data.things_done_well || []).forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      rsGood.appendChild(li);
    });

    rsImprove.innerHTML = '';
    (data.things_to_improve || []).forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      rsImprove.appendChild(li);
    });

    rsNextTip.textContent = data.key_tip_for_next_round || '';

    const rating = Math.max(1, Math.min(5, data.performance_rating || 3));
    rsStars.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const s = document.createElement('div');
      s.className = 'rs-star' + (i <= rating ? ' on' : '');
      rsStars.appendChild(s);
    }

    roundSummary.classList.remove('hidden');
    requestAnimationFrame(() => roundSummary.classList.add('visible'));

    const SUMMARY_DURATION = 12000;
    rsTimerFill.style.transition = 'none';
    rsTimerFill.style.transform  = 'scaleX(1)';
    requestAnimationFrame(() => {
      rsTimerFill.style.transition = `transform ${SUMMARY_DURATION}ms linear`;
      rsTimerFill.style.transform  = 'scaleX(0)';
    });

    summaryTimer = setTimeout(dismissRoundSummary, SUMMARY_DURATION);
  }

  function dismissRoundSummary() {
    roundSummary.classList.remove('visible');
    setTimeout(() => roundSummary.classList.add('hidden'), 450);
  }

  // ─── Match summary (auto-dismiss after 30s, no close button) ─────────────────
  const MATCH_SUMMARY_DURATION = 30000;

  function showMatchSummary(data) {
    if (matchSummaryTimer) clearTimeout(matchSummaryTimer);

    const res = (data.match_result || 'unknown').toLowerCase();
    msResult.textContent = res === 'victory' ? 'VICTORY' : res === 'defeat' ? 'DEFEAT' : 'MATCH ENDED';
    msResult.className   = 'ms-result-badge ' + (res === 'victory' ? 'victory' : res === 'defeat' ? 'defeat' : 'unknown');

    const rating = Math.max(1, Math.min(10, data.overall_rating || 5));
    msRatingNum.textContent = rating;
    msRatingCircle.className = 'ms-rating-circle ' + (rating >= 7 ? 'high' : rating >= 4 ? 'mid' : 'low');
    msTipsCount.textContent  = data.tipsCount ? `${data.tipsCount} coaching tips given` : '';

    msStrengths.innerHTML = '';
    (data.strengths || []).forEach(item => {
      const li = document.createElement('li'); li.textContent = item; msStrengths.appendChild(li);
    });

    msWeaknesses.innerHTML = '';
    (data.weaknesses || []).forEach(item => {
      const li = document.createElement('li'); li.textContent = item; msWeaknesses.appendChild(li);
    });

    msFocusTip.textContent = data.biggest_improvement_tip || '';

    matchSummary.classList.remove('hidden');

    // Enable mouse events on the overlay so close button works
    if (window.overlayAPI && window.overlayAPI.setInteractive) {
      window.overlayAPI.setInteractive(true);
    }

    const closeBtn = document.getElementById('ms-close');
    if (closeBtn) {
      closeBtn.onclick = () => dismissMatchSummary();
    }

    // Animate auto-close bar
    if (msAutoBarFill) {
      msAutoBarFill.style.transition = 'none';
      msAutoBarFill.style.transform  = 'scaleX(1)';
      requestAnimationFrame(() => {
        msAutoBarFill.style.transition = `transform ${MATCH_SUMMARY_DURATION}ms linear`;
        msAutoBarFill.style.transform  = 'scaleX(0)';
      });
    }

    matchSummaryTimer = setTimeout(() => dismissMatchSummary(), MATCH_SUMMARY_DURATION);

    // Save to localStorage for match history
    try {
      const key = 'ghostcoach_match_' + Date.now();
      localStorage.setItem(key, JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
      // Keep only last 10 match reviews
      const allKeys = Object.keys(localStorage)
        .filter(k => k.startsWith('ghostcoach_match_'))
        .sort();
      while (allKeys.length > 10) localStorage.removeItem(allKeys.shift());
    } catch (e) { /* storage unavailable */ }
  }

  function dismissMatchSummary() {
    if (matchSummaryTimer) { clearTimeout(matchSummaryTimer); matchSummaryTimer = null; }
    matchSummary.classList.add('hidden');
    if (window.overlayAPI && window.overlayAPI.setInteractive) {
      window.overlayAPI.setInteractive(false);
    }
  }

  // ─── Session Over card ────────────────────────────────────────────────────────
  function showSessionOver(data) {
    if (!sessionOverCard) return;

    const tipsCount = data.tipsCount || 0;
    soTips.textContent = tipsCount + (tipsCount === 1 ? ' tip' : ' tips');

    if (data.sessionStart) {
      const mins = Math.floor((Date.now() - data.sessionStart) / 60000);
      soTime.textContent = mins + 'm session';
    } else {
      soTime.textContent = '';
    }

    sessionOverCard.classList.remove('hidden', 'exiting');

    setTimeout(() => {
      sessionOverCard.classList.add('exiting');
      setTimeout(() => {
        sessionOverCard.classList.add('hidden');
        sessionOverCard.classList.remove('exiting');
      }, 350);
    }, 5000);
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ─── Overlay (panel) position ────────────────────────────────────────────────
  const OVERLAY_POS_MAP = {
    'top-left':     { top: '20px', left: '20px', right: 'auto', bottom: 'auto' },
    'top-right':    { top: '20px', right: '20px', left: 'auto', bottom: 'auto' },
    'bottom-left':  { bottom: '20px', left: '20px', top: 'auto', right: 'auto' },
    'bottom-right': { bottom: '20px', right: '20px', top: 'auto', left: 'auto' },
  };

  function applyOverlayPosition(pos) {
    overlayPosition = pos || 'top-left';
    const p = OVERLAY_POS_MAP[overlayPosition] || OVERLAY_POS_MAP['top-left'];
    [panel, panelMini].forEach(el => {
      el.style.top    = p.top    || '';
      el.style.right  = p.right  || '';
      el.style.bottom = p.bottom || '';
      el.style.left   = p.left   || '';
    });
  }

  // ─── Tip container position ───────────────────────────────────────────────────
  function applyTipPosition(pos) {
    tipPosition = pos || 'bottom-right';
    const container = document.getElementById('tip-container');
    const histPanel = document.getElementById('tip-history');
    const isRight   = tipPosition.includes('right');
    const isTop     = tipPosition.includes('top');

    if (container) {
      container.style.position      = 'fixed';
      container.style.top           = isTop   ? '80px' : 'auto';
      container.style.bottom        = isTop   ? 'auto' : '80px';
      container.style.right         = isRight ? '20px' : 'auto';
      container.style.left          = isRight ? 'auto' : '20px';
      container.style.display       = 'flex';
      container.style.flexDirection = 'column';
      container.style.alignItems    = isRight ? 'flex-end' : 'flex-start';
    }

    // History panel on the opposite side
    if (histPanel) {
      histPanel.style.right = isRight ? 'auto' : '20px';
      histPanel.style.left  = isRight ? '20px' : 'auto';
    }
  }

  // ─── Minimize panel ───────────────────────────────────────────────────────────
  function applyMinimizeState(minimized, animate) {
    isPanelMinimized = minimized;
    if (minimized) {
      if (animate) {
        panel.classList.add('panel-hiding');
        setTimeout(() => { panel.classList.add('hidden'); panel.classList.remove('panel-hiding'); }, 200);
      } else {
        panel.classList.add('hidden');
      }
      panelMini.classList.remove('hidden');
      requestAnimationFrame(() => panelMini.classList.add('mini-visible'));
    } else {
      panel.classList.remove('hidden');
      requestAnimationFrame(() => panel.classList.remove('panel-hiding'));
      panelMini.classList.remove('mini-visible');
      setTimeout(() => panelMini.classList.add('hidden'), 200);
    }
  }

  function showMiniToast(text) {
    if (!miniToast) return;
    if (miniToastTimer) { clearTimeout(miniToastTimer); miniToastTimer = null; }
    miniToast.textContent = text;
    miniToast.classList.remove('hidden');
    requestAnimationFrame(() => miniToast.classList.add('toast-visible'));
    miniToastTimer = setTimeout(() => {
      miniToast.classList.remove('toast-visible');
      setTimeout(() => miniToast.classList.add('hidden'), 150);
      miniToastTimer = null;
    }, 2000);
  }

  // ─── IPC listeners ────────────────────────────────────────────────────────────
  if (window.overlayAPI) {

    // Full state sync from main process
    window.overlayAPI.onState((state) => {
      isCoaching = !!state.isCoaching;
      isPaused   = !!state.isPaused;

      // FIX 2: init minimize state without animation
      if (state.panelMinimized !== undefined) {
        applyMinimizeState(!!state.panelMinimized, false);
      }

      if (state.tipPos)         applyTipPosition(state.tipPos);
      if (state.overlayPosition) applyOverlayPosition(state.overlayPosition);
      if (state.performanceMode) {
        performanceMode = state.performanceMode;
        updatePerfIndicator();
      }

      if (isCoaching) {
        setStatus('coaching', 'Coaching');
        sessionStats.classList.remove('hidden');
        if (state.sessionStart && !sessionStartTime) {
          sessionStartTime = state.sessionStart;
          startSessionTimer();
        }
      } else {
        setStatus('idle', 'Ready');
        sessionStats.classList.add('hidden');
        stopSessionTimer();
        sessionStartTime = null;
      }

      if (state.tipCount !== undefined) {
        sessionTipCount = state.tipCount;
        updateSessionStats();
      }
    });

    // New coaching tip (new engine path via show-tip)
    window.overlayAPI.onShowTip((data) => {
      console.log('[overlay] Received tip:', data.text, data.source);
      if (overlayHidden) {
        hiddenTipBuffer.push(data);
        if (hiddenTipBuffer.length > 5) hiddenTipBuffer.shift();
        return;
      }
      showTipCard(data.text, data.source, data.category);
    });

    // Legacy coach:tip path (kept for backwards compat)
    window.overlayAPI.onTip((data) => {
      if (overlayHidden) {
        hiddenTipBuffer.push(data);
        if (hiddenTipBuffer.length > 5) hiddenTipBuffer.shift();
        return;
      }
      showTip(data);
    });

    // Round summary
    window.overlayAPI.onRoundSummary((data) => {
      showRoundSummary(data);
    });

    // Match summary
    window.overlayAPI.onMatchSummary((data) => {
      showMatchSummary(data);
    });

    // Fix 4: Session over card
    window.overlayAPI.onSessionOver((data) => {
      showSessionOver(data);
      // Reset local session state
      stopSessionTimer();
      sessionStartTime = null;
      sessionTipCount  = 0;
    });

    // Status updates
    window.overlayAPI.onStatus((data) => {
      setStatus(data.status, data.message);
    });

    // Fix 3: Visibility toggle — hide/show panel, buffer tips when hidden
    window.overlayAPI.onVisibility((data) => {
      const vis = data.visible;
      overlayHidden = !vis;

      // When fully hidden (Ctrl+Shift+G toggle), hide everything
      panel.style.visibility        = vis ? 'visible' : 'hidden';
      hudTips.style.visibility      = vis ? 'visible' : 'hidden';
      roundSummary.style.visibility = vis ? 'visible' : 'hidden';
      // hudTips is NOT affected by panel minimize — tips show even when panel is minimized

      if (overlayHiddenIndicator) {
        overlayHiddenIndicator.classList.toggle('hidden', vis);
      }

      // When showing, flush the hidden tip buffer (show most recent)
      if (vis && hiddenTipBuffer.length > 0) {
        const mostRecent = hiddenTipBuffer[hiddenTipBuffer.length - 1];
        hiddenTipBuffer = [];
        if (mostRecent.source) {
          showTipCard(mostRecent.text, mostRecent.source, mostRecent.category);
        } else {
          showTip(mostRecent);
        }
      }
    });

    // Match detection state
    window.overlayAPI.onMatchState((data) => {
      if (data.state === 'waiting_for_match') {
        setStatus('waiting_for_match');
      } else if (data.state === 'in_match' && isCoaching) {
        setStatus('coaching', 'Coaching');
      }
    });

    // Player alive/dead state
    window.overlayAPI.onPlayerState((data) => {
      if (data.state === 'dead') {
        setStatus('player_dead');
      } else if (isCoaching) {
        setStatus('coaching', 'Coaching');
      }
    });

    // Pause state
    window.overlayAPI.onPauseState((data) => {
      isPaused = data.paused;
      if (data.paused) {
        setStatus('paused', 'Paused');
      } else if (isCoaching) {
        setStatus('coaching', 'Coaching');
      }
    });

    // FIX 2: Minimize / restore panel
    window.overlayAPI.onMinimize((data) => {
      applyMinimizeState(!!data.minimized, true);
    });

    // FIX 2: Mini toast notification
    window.overlayAPI.onMiniToast((data) => {
      if (isPanelMinimized && data.text) showMiniToast(data.text);
    });

    // Round recap card
    if (window.overlayAPI.onRecap) {
      window.overlayAPI.onRecap((data) => {
        showRecap(data);
      });
    }

    // Toggle tip history panel (Ctrl+Shift+H)
    if (window.overlayAPI.onToggleHistory) {
      window.overlayAPI.onToggleHistory(() => {
        historyVisible = !historyVisible;
        if (tipHistory) {
          tipHistory.classList.toggle('hidden', !historyVisible);
          if (historyVisible) renderHistory();
        }
      });
    }

    // Tray coaching toggle — not used since overlay is display-only
    // but we keep the listener for the tray menu compatibility
    window.overlayAPI.onTrayToggle(() => {
      // No-op — coaching is controlled from settings window or hotkeys
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  updatePerfIndicator();
  applyOverlayPosition(overlayPosition);
  applyTipPosition(tipPosition);

})();
