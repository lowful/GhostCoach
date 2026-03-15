require('dotenv').config();

const { app, ipcMain, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const https = require('https');
const http  = require('http');
const store = require('./store');
const {
  createOverlayWindow,
  createTray,
  updateTrayMenu,
  toggleOverlay,
  showOverlay,
  sendToOverlay,
  getOverlayWindow
} = require('./overlay');
const { createSettingsWindow, sendToSettings, getSettingsWindow } = require('./settings-window');
const { captureScreen } = require('./capture');
const {
  analyzeScreenshot,
  getRoundSummary,
  checkIfMatch,
  checkIfAlive,
  getMatchSummary
} = require('./api');
const { registerHotkeys, unregisterHotkeys } = require('./hotkeys');

// ─── Session State ─────────────────────────────────────────────────────────────
let activationWindow = null;
let isCoaching     = false;
let isPaused       = false;
let captureTimer   = null;
let setupWindow    = null;
let tipHistory     = [];        // all tips this session (max 20)
let roundSummaries = [];        // round summaries this session
let lastCapture    = 0;
let lastRoundEnd   = 0;         // debounce duplicate ROUND_END signals
let sessionStartTime = null;
let captureCount   = 0;         // count captures to trigger periodic match re-check

// Match + player state machines
let matchState   = 'idle';      // idle | waiting_for_match | in_match
let playerState  = 'alive';     // alive | dead

// Accumulate tips for end-of-match summary
let matchTipsForSummary = [];

// ─── Fix 1: Death tip hard cap + rate limiter ──────────────────────────────────
let deathTipSent      = false;
let lastAliveCheckTime = 0;
let tipTimestamps     = [];     // timestamps of tips shown in last 30s

function canShowTip() {
  const now = Date.now();
  tipTimestamps = tipTimestamps.filter(t => now - t < 30000);
  if (tipTimestamps.length >= 3) return false;
  tipTimestamps.push(now);
  return true;
}

// ─── Fix 5: Combat tip tracking ───────────────────────────────────────────────
let combatTipGiven = false;

// ─── Setup Window ─────────────────────────────────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 500,
    height: 440,
    frame: false,
    transparent: false,
    resizable: false,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-setup.js')
    },
    backgroundColor: '#0F1923'
  });

  setupWindow.loadFile(path.join(__dirname, '../renderer/setup/index.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ─── Activation Window ────────────────────────────────────────────────────────
function createActivationWindow() {
  activationWindow = new BrowserWindow({
    width: 500,
    height: 480,
    frame: false,
    transparent: false,
    resizable: false,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-activate.js')
    },
    backgroundColor: '#0F1923'
  });

  activationWindow.loadFile(path.join(__dirname, '../renderer/activate/index.html'));
  activationWindow.on('closed', () => { activationWindow = null; });
}

// ─── License validation helper ────────────────────────────────────────────────
function validateLicenseWithServer(key) {
  return new Promise((resolve, reject) => {
    const serverUrl = store.get('serverUrl') || 'https://ghostcoach-production.up.railway.app/api';
    const body = JSON.stringify({ key });
    const url = new URL(`${serverUrl}/license/validate`);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('Invalid JSON response from server'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(body);
    req.end();
  });
}

// ─── Performance interval ──────────────────────────────────────────────────────
function getBaseInterval() {
  const mode = store.get('performanceMode');
  switch (mode) {
    case 'quality':     return 8000;
    case 'lightweight': return 20000;
    default:            return store.get('captureInterval') || 15000; // balanced
  }
}

// ─── Capture + Analysis ────────────────────────────────────────────────────────
async function runCapture(forced = false) {
  const apiKey = store.get('apiKey');
  if (!apiKey || isPaused) return;

  const now = Date.now();
  const minGap = Math.max(5000, getBaseInterval() * 0.8);
  if (!forced && now - lastCapture < minGap) return;
  lastCapture = now;
  captureCount++;

  const overlayWin = getOverlayWindow();

  try {
    sendToOverlay('coach:status', { status: 'capturing' });
    sendToSettings('settings:status', { status: 'capturing' });

    // Hide overlay so it doesn't contaminate the screenshot
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setOpacity(0);
    }
    await new Promise(r => setTimeout(r, 20)); // Fix 2: reduced from 80ms to 20ms

    const base64 = await captureScreen();

    // Restore overlay immediately
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setOpacity(1);
    }

    // ── Match detection: first capture, or re-check every 5th capture ──────────
    const shouldCheckMatch = (matchState === 'idle') ||
                             (matchState === 'waiting_for_match') ||
                             (matchState === 'in_match' && captureCount % 5 === 0);

    if (shouldCheckMatch) {
      const statusData = { status: 'detecting' };
      sendToOverlay('coach:status', statusData);
      sendToSettings('settings:status', statusData);
      const inMatch = await checkIfMatch(base64, apiKey);

      if (!inMatch) {
        matchState = 'waiting_for_match';
        playerState = 'alive';
        deathTipSent = false;
        combatTipGiven = false;
        sendToOverlay('coach:matchState', { state: 'waiting_for_match' });
        sendToOverlay('coach:status', { status: 'waiting_for_match' });
        sendToSettings('settings:status', { status: 'waiting_for_match' });
        return;
      } else if (matchState !== 'in_match') {
        matchState = 'in_match';
        matchTipsForSummary = []; // reset tips for new match
        sendToOverlay('coach:matchState', { state: 'in_match' });
      }
    }

    // ── Fix 1: Death handling with hard cap ───────────────────────────────────
    const continueWhileDead = store.get('continueCoachingWhileDead');

    if (playerState === 'dead') {
      if (deathTipSent && !continueWhileDead) {
        // Only check alive every 10 seconds
        if (now - lastAliveCheckTime < 10000) {
          sendToOverlay('coach:status', { status: 'player_dead' });
          sendToSettings('settings:status', { status: 'player_dead' });
          return;
        }
        lastAliveCheckTime = now;
        const alive = await checkIfAlive(base64, apiKey);
        if (alive) {
          playerState = 'alive';
          deathTipSent = false;
          combatTipGiven = false;
          sendToOverlay('coach:playerState', { state: 'alive' });
          sendToOverlay('coach:status', { status: 'coaching' });
          sendToSettings('settings:status', { status: 'coaching' });
          // Fall through to normal coaching
        } else {
          sendToOverlay('coach:status', { status: 'player_dead' });
          sendToSettings('settings:status', { status: 'player_dead' });
          return;
        }
      } else if (!continueWhileDead && !deathTipSent) {
        // Not yet sent death tip — check alive first
        const alive = await checkIfAlive(base64, apiKey);
        if (alive) {
          playerState = 'alive';
          deathTipSent = false;
          combatTipGiven = false;
          sendToOverlay('coach:playerState', { state: 'alive' });
          sendToOverlay('coach:status', { status: 'coaching' });
          sendToSettings('settings:status', { status: 'coaching' });
          // Fall through
        } else {
          // Still dead, fall through to let AI provide death tip
        }
      }
    }

    const mode = store.get('coachingMode');
    const analyzeStatusData = { status: 'analyzing' };
    sendToOverlay('coach:status', analyzeStatusData);
    sendToSettings('settings:status', analyzeStatusData);

    const recentTips = matchTipsForSummary.slice(-5);
    const result = await analyzeScreenshot(base64, apiKey, mode, combatTipGiven, recentTips);

    if (!result) {
      const coachData = { status: 'coaching' };
      sendToOverlay('coach:status', coachData);
      sendToSettings('settings:status', coachData);
      return;
    }

    const upper = result.toUpperCase();

    // WAITING — never display; check if match ended
    if (upper.startsWith('WAITING')) {
      matchState = 'waiting_for_match';
      playerState = 'alive';
      deathTipSent = false;
      combatTipGiven = false;
      sendToOverlay('coach:matchState', { state: 'waiting_for_match' });
      sendToOverlay('coach:status', { status: 'waiting_for_match' });
      sendToSettings('settings:status', { status: 'waiting_for_match' });
      return;
    }

    // ACTIVE_COMBAT — backward-compat filter (old prompt responses)
    if (upper.startsWith('ACTIVE_COMBAT')) {
      sendToOverlay('coach:status', { status: 'active_combat' });
      sendToSettings('settings:status', { status: 'active_combat' });
      return;
    }

    // ACTIVE_WAIT — Fix 5: AI says a combat tip was already given this encounter
    if (upper.startsWith('ACTIVE_WAIT')) {
      sendToOverlay('coach:status', { status: 'active_combat' });
      sendToSettings('settings:status', { status: 'active_combat' });
      // Don't reset combatTipGiven — combat is still ongoing
      return;
    }

    // ROUND_END — trigger summary with debounce; reset combat flag
    if (upper.startsWith('ROUND_END')) {
      combatTipGiven = false;
      deathTipSent = false;
      if (now - lastRoundEnd > 30000) {
        lastRoundEnd = now;
        triggerRoundSummary(base64, apiKey);
      }
      sendToOverlay('coach:status', { status: 'round_end' });
      sendToSettings('settings:status', { status: 'round_end' });
      return;
    }

    // PLAYER_DEAD — show styled death tip, then pause analysis
    if (upper.startsWith('PLAYER_DEAD')) {
      const parts = result.split('|');
      const deathTip = parts[1] ? parts[1].trim() : null;

      if (!continueWhileDead) {
        playerState = 'dead';
        lastAliveCheckTime = now;
        sendToOverlay('coach:playerState', { state: 'dead' });
      }

      combatTipGiven = false; // reset combat on death

      if (deathTip && deathTip.length > 2 && !deathTipSent) {
        if (canShowTip()) {
          const tipData = {
            text:       deathTip,
            game:       'Valorant',
            timestamp:  Date.now(),
            isDeathTip: true
          };
          tipHistory.unshift(tipData);
          if (tipHistory.length > 20) tipHistory.pop();
          matchTipsForSummary.push(deathTip);
          deathTipSent = true;
          sendToOverlay('coach:tip', tipData);
          sendToOverlay('coach:state', buildState());
          sendToSettings('settings:state', buildState());
          sendToSettings('settings:status', { status: 'player_dead' });
        }
      }

      sendToOverlay('coach:status', { status: 'player_dead' });
      sendToSettings('settings:status', { status: 'player_dead' });
      return;
    }

    // ── Real coaching tip ──────────────────────────────────────────────────────
    // Validate: non-empty, not a filter keyword, under 200 chars
    let tipText = result;
    if (!tipText || tipText.length < 3) {
      sendToOverlay('coach:status', { status: 'coaching' });
      sendToSettings('settings:status', { status: 'coaching' });
      return;
    }
    if (tipText.length > 200) {
      const firstSentence = tipText.match(/^[^.!?]+[.!?]/);
      tipText = firstSentence ? firstSentence[0].trim() : tipText.substring(0, 150).trim();
    }

    // Fix 1: global rate limiter
    if (!canShowTip()) {
      sendToOverlay('coach:status', { status: 'coaching' });
      sendToSettings('settings:status', { status: 'coaching' });
      return;
    }

    // Fix 5: mark that a tip was given for this combat encounter
    combatTipGiven = true;

    const tipData = { text: tipText, game: 'Valorant', timestamp: Date.now(), isDeathTip: false };
    tipHistory.unshift(tipData);
    if (tipHistory.length > 20) tipHistory.pop();
    matchTipsForSummary.push(tipText);

    sendToOverlay('coach:tip', tipData);
    sendToOverlay('coach:state', buildState());
    sendToOverlay('coach:status', { status: 'coaching' });
    sendToSettings('settings:state', buildState());
    sendToSettings('settings:status', { status: 'coaching' });

  } catch (err) {
    // Always restore overlay opacity on error
    if (overlayWin && !overlayWin.isDestroyed()) {
      try { overlayWin.setOpacity(1); } catch (_) {}
    }

    const msg = err.message || '';
    let errStatus;
    if (msg.includes('timeout') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
      errStatus = { status: 'connection_lost' };
    } else if (msg.includes('401') || msg.includes('403') || msg.includes('authentication')) {
      errStatus = { status: 'auth_error' };
    } else if (msg.includes('429') || msg.includes('rate')) {
      errStatus = { status: 'rate_limited' };
    } else {
      errStatus = { status: 'error', message: msg };
    }
    sendToOverlay('coach:status', errStatus);
    sendToSettings('settings:status', errStatus);
    console.error('[capture] Error:', msg);
  }
}

// ─── Round summary ─────────────────────────────────────────────────────────────
async function triggerRoundSummary(base64, apiKey) {
  try {
    const sumStatus = { status: 'summarizing' };
    sendToOverlay('coach:status', sumStatus);
    sendToSettings('settings:status', sumStatus);
    const summary = await getRoundSummary(base64, apiKey);
    if (summary) {
      const data = { ...summary, game: 'Valorant', timestamp: Date.now() };
      roundSummaries.unshift(data);
      sendToOverlay('coach:roundSummary', data);
      sendToOverlay('coach:state', buildState());
      sendToSettings('settings:state', buildState());
    }
  } catch (err) {
    console.error('[round-summary] Error:', err.message);
  }
}

// ─── Match summary ─────────────────────────────────────────────────────────────
async function triggerMatchSummary(apiKey) {
  if (matchTipsForSummary.length < 3) return;
  const tips = [...matchTipsForSummary];
  matchTipsForSummary = [];

  try {
    const summary = await getMatchSummary(tips, apiKey);
    if (summary) {
      const data = { ...summary, game: 'Valorant', timestamp: Date.now(), tipsCount: tips.length };
      saveMatchSummary(data);
      sendToOverlay('coach:matchSummary', data);
    }
  } catch (err) {
    console.error('[match-summary] Error:', err.message);
  }
}

// ─── Coaching Loop ─────────────────────────────────────────────────────────────
function startCoaching() {
  if (isCoaching) return;
  isCoaching    = true;
  isPaused      = false;
  sessionStartTime = Date.now();
  matchState    = 'idle';
  playerState   = 'alive';
  captureCount  = 0;
  deathTipSent  = false;
  combatTipGiven = false;

  // 3-second warmup so the game can stabilize FPS before we take a screenshot
  setTimeout(() => {
    if (isCoaching && !isPaused) runCapture(true);
  }, 3000);

  const interval = getBaseInterval();
  captureTimer = setInterval(() => {
    if (isCoaching && !isPaused) runCapture();
  }, interval);

  updateTrayMenu(true);
  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToSettings('settings:state', state);
  console.log(`[coach] Started — ${interval}ms interval, mode: ${store.get('coachingMode')}, perf: ${store.get('performanceMode')}`);
}

function stopCoaching() {
  if (!isCoaching) return;
  isCoaching = false;
  isPaused   = false;

  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }

  // Fix 4: Send session-over card BEFORE resetting sessionStartTime
  sendToOverlay('coach:sessionOver', {
    tipsCount: tipHistory.length,
    sessionStart: sessionStartTime
  });

  // Remove match summary on manual stop per Fix 4
  // (match summary only triggers on in-match end detection now)

  deathTipSent  = false;
  combatTipGiven = false;
  matchState   = 'idle';
  playerState  = 'alive';
  sessionStartTime = null;
  captureCount = 0;

  saveSession();
  updateTrayMenu(false);
  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToOverlay('coach:status', { status: 'stopped' });
  sendToSettings('settings:state', state);
  sendToSettings('settings:status', { status: 'stopped' });
  console.log('[coach] Stopped');
}

function pauseResumeCoaching() {
  if (!isCoaching) return;
  isPaused = !isPaused;

  if (isPaused) {
    sendToOverlay('coach:status', { status: 'paused' });
    sendToSettings('settings:status', { status: 'paused' });
  } else {
    sendToOverlay('coach:status', { status: 'coaching' });
    sendToSettings('settings:status', { status: 'coaching' });
    runCapture(true); // immediate analysis on resume
  }

  sendToOverlay('coach:pauseState', { paused: isPaused });
  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToSettings('settings:state', state);
  console.log('[coach]', isPaused ? 'Paused' : 'Resumed');
}

function buildState() {
  return {
    isCoaching,
    isPaused,
    game:               'Valorant',
    interval:           store.get('captureInterval'),
    mode:               store.get('coachingMode'),
    tipPos:             store.get('tipPosition'),
    audio:              store.get('audioEnabled'),
    panelPos:           store.get('panelPosition'),
    performanceMode:    store.get('performanceMode'),
    continueWhileDead:  store.get('continueCoachingWhileDead'),
    onboardingCompleted: store.get('onboardingCompleted'),
    history:            tipHistory,
    summaries:          roundSummaries,
    sessionStart:       sessionStartTime,
    tipCount:           tipHistory.length,
    matchState,
    playerState,
    panelMinimized:     store.get('panelMinimized')
  };
}

// ─── Persistence ───────────────────────────────────────────────────────────────
function saveSession() {
  if (roundSummaries.length === 0 && tipHistory.length === 0) return;
  try {
    const dir = path.join(app.getPath('userData'), 'sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `session-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify({
      timestamp: new Date().toISOString(),
      game: 'Valorant',
      tipHistory,
      roundSummaries
    }, null, 2));
    console.log('[session] Saved to', file);
  } catch (err) {
    console.error('[session] Save failed:', err.message);
  }
}

function saveMatchSummary(data) {
  try {
    const dir = path.join(app.getPath('userData'), 'match-summaries');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `match-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log('[match] Summary saved to', file);
  } catch (err) {
    console.error('[match] Save failed:', err.message);
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────────
function cleanup() {
  try {
    if (isCoaching) stopCoaching();
    unregisterHotkeys();
    saveSession();
  } catch (err) {
    console.error('[cleanup] Error:', err.message);
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Overlay handlers (minimal — overlay is display-only)
ipcMain.on('overlay:completeOnboarding', () => {
  store.set('onboardingCompleted', true);
  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToSettings('settings:state', state);
});

ipcMain.on('overlay:resetOnboarding', () => {
  store.set('onboardingCompleted', false);
  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToSettings('settings:state', state);
});

// Fix 2: close is handled in renderer; main just quits
ipcMain.on('overlay:doClose', () => {
  cleanup();
  app.quit();
});

// ─── Settings window IPC handlers ─────────────────────────────────────────────
ipcMain.on('settings:startCoaching',  () => startCoaching());
ipcMain.on('settings:stopCoaching',   () => stopCoaching());
ipcMain.on('settings:pauseResume',    () => pauseResumeCoaching());
ipcMain.on('settings:forceCapture',   () => runCapture(true));

ipcMain.on('settings:forceSummary', async () => {
  const apiKey = store.get('apiKey');
  if (!apiKey) return;
  const overlayWin = getOverlayWindow();
  if (overlayWin) overlayWin.setOpacity(0);
  await new Promise(r => setTimeout(r, 20));
  const base64 = await captureScreen();
  if (overlayWin) overlayWin.setOpacity(1);
  triggerRoundSummary(base64, apiKey);
});

ipcMain.on('settings:updateApiKey', (_, key) => {
  store.set('apiKey', key.trim());
});

ipcMain.on('settings:quit', () => {
  cleanup();
  app.quit();
});

ipcMain.on('settings:save', (_, settings) => {
  if (settings.mode)                                   store.set('coachingMode', settings.mode);
  if (settings.interval)                               store.set('captureInterval', Math.max(5000, Math.min(60000, settings.interval)));
  if (settings.tipPos)                                 store.set('tipPosition', settings.tipPos);
  if (typeof settings.audio === 'boolean')             store.set('audioEnabled', settings.audio);
  if (settings.performanceMode)                        store.set('performanceMode', settings.performanceMode);
  if (typeof settings.continueWhileDead === 'boolean') store.set('continueCoachingWhileDead', settings.continueWhileDead);

  // Restart the capture timer with the new interval if coaching is active
  if (isCoaching && (settings.interval || settings.performanceMode)) {
    clearInterval(captureTimer);
    captureTimer = setInterval(() => { if (isCoaching && !isPaused) runCapture(); }, getBaseInterval());
  }

  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToSettings('settings:state', state);
});

// Setup window
ipcMain.on('setup:saveKey', (_, key) => {
  store.set('apiKey', key.trim());
  launchMainApp();
  if (setupWindow) setupWindow.close();
});

ipcMain.on('setup:openExternal', (_, url) => {
  shell.openExternal(url);
});

// ─── Activation IPC handlers ──────────────────────────────────────────────────

ipcMain.handle('activate:validateKey', async (_, key) => {
  try {
    const result = await validateLicenseWithServer(key);

    if (result.valid) {
      // Persist license data locally
      store.set('licenseKey',    key.trim().toUpperCase());
      store.set('licenseStatus', result.status  || 'active');
      store.set('licensePlan',   result.plan    || '');
      store.set('licenseExpiry', result.expiresAt || '');

      // Close activation window and proceed to app
      if (activationWindow && !activationWindow.isDestroyed()) {
        activationWindow.close();
      }

      // Show setup or main app depending on whether API key is saved
      if (!store.get('apiKey')) {
        createSetupWindow();
      } else {
        launchMainApp();
      }
    }

    return result;
  } catch (err) {
    console.error('[activate] Validation error:', err.message);

    // Offline grace: if a previously validated key is stored, allow entry
    const cachedKey    = store.get('licenseKey');
    const cachedStatus = store.get('licenseStatus');
    const cachedExpiry = store.get('licenseExpiry');

    if (
      cachedKey &&
      cachedKey.toUpperCase() === key.trim().toUpperCase() &&
      cachedStatus === 'active'
    ) {
      // Check cached expiry
      const expired = cachedExpiry ? new Date(cachedExpiry) < new Date() : false;
      if (!expired) {
        console.log('[activate] Server unreachable — using cached license');

        if (activationWindow && !activationWindow.isDestroyed()) {
          activationWindow.close();
        }

        if (!store.get('apiKey')) {
          createSetupWindow();
        } else {
          launchMainApp();
        }

        return { valid: true, plan: store.get('licensePlan'), status: 'active', expiresAt: cachedExpiry };
      }
    }

    return { valid: false, error: 'Could not connect to server. Check your internet connection.' };
  }
});

ipcMain.on('activate:openPurchase', () => {
  shell.openExternal('https://ghostcoachai.com');
});

ipcMain.on('activate:quit', () => {
  cleanup();
  app.quit();
});

// ─── App Launch ───────────────────────────────────────────────────────────────
function launchMainApp() {
  createOverlayWindow();
  createTray();

  const overlayWin = getOverlayWindow();
  overlayWin.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const state = buildState();
      sendToOverlay('coach:state', state);
    }, 300);
  });

  // Send initial minimized state to overlay after load
  overlayWin.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const minimized = store.get('panelMinimized') || false;
      if (minimized) sendToOverlay('overlay:minimize', { minimized: true });
    }, 350);
  });

  registerHotkeys({
    toggleOverlay:   () => toggleOverlay(),
    forceCapture:    () => {
      runCapture(true);
      sendToOverlay('overlay:miniToast', { text: 'Scanning...' });
    },
    pauseResume:     () => {
      pauseResumeCoaching();
      sendToOverlay('overlay:miniToast', { text: isPaused ? 'Resumed' : 'Paused' });
    },
    openSettings:    () => createSettingsWindow(buildState()),
    minimizeOverlay: () => {
      const nowMinimized = !store.get('panelMinimized');
      store.set('panelMinimized', nowMinimized);
      sendToOverlay('overlay:minimize', { minimized: nowMinimized });
    },
    quit:            () => { cleanup(); app.quit(); }
  });
}

// ─── App Events ───────────────────────────────────────────────────────────────
app.setAppUserModelId('com.ghostcoach.app');

app.whenReady().then(() => {
  const licenseKey    = store.get('licenseKey');
  const licenseStatus = store.get('licenseStatus');
  const licenseExpiry = store.get('licenseExpiry');

  // Determine whether the stored license is still valid (or lifetime)
  const licenseValid = licenseKey &&
    licenseStatus === 'active' &&
    (!licenseExpiry || new Date(licenseExpiry) > new Date());

  if (!licenseValid) {
    // No valid license — show activation screen first
    createActivationWindow();
    return;
  }

  // License is valid — proceed to app or setup
  if (!store.get('apiKey')) {
    createSetupWindow();
  } else {
    launchMainApp();
  }
});

app.on('window-all-closed', () => {
  // Don't quit on window-all-closed — tray keeps the app alive
  // Only quit explicitly
});

app.on('will-quit', () => {
  unregisterHotkeys();
  if (isCoaching) saveSession();
});

// ─── Crash Handlers ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[crash] Uncaught exception:', err.stack || err.message);
  try {
    const logFile = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${err.stack || err.message}\n`);
  } catch (_) {}
  try { cleanup(); } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[crash] Unhandled promise rejection:', reason);
});
