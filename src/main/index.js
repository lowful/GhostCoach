require('dotenv').config();

const { app, ipcMain, BrowserWindow, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const os     = require('os');
const crypto = require('crypto');
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
  getMatchSummary,
  isDuplicateTip,
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

// ─── In-flight guard + dedup state ─────────────────────────────────────────────
let requestInFlight = false;   // prevents parallel API calls
let lastTipTime     = 0;       // enforces 20s min gap between tips
let lastScreenHash  = '';      // last screenshot hash for duplicate detection

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

// ─── Device ID ───────────────────────────────────────────────────────────────
function getDeviceId() {
  const raw = `${os.hostname()}::${os.userInfo().username}::${process.platform}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getDeviceName() {
  return os.hostname() || 'Unknown Device';
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function serverPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const serverUrl = store.get('serverUrl') || 'https://ghostcoach-production.up.railway.app/api';
    const payload = JSON.stringify(body);
    const url = new URL(`${serverUrl}${endpoint}`);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response from server')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

// ─── License helpers ─────────────────────────────────────────────────────────
function activateLicenseWithServer(key) {
  return serverPost('/license/activate', {
    key,
    device_id:   getDeviceId(),
    device_name: getDeviceName(),
  });
}

function validateLicenseWithServer(key) {
  return serverPost('/license/validate', {
    key,
    device_id: getDeviceId(),
  });
}

// Maps non-active license states to user-facing overlay messages
const LICENSE_STATE_MESSAGES = {
  expired:        'Your license has expired. Visit ghostcoachai.com to renew.',
  cancelled:      'Your subscription was cancelled. Visit ghostcoachai.com to resubscribe.',
  payment_failed: 'Payment failed. Please update your payment method at ghostcoachai.com.',
  device_mismatch:'This key is activated on another device. Log in at ghostcoachai.com to deactivate it first.',
};

function handleInvalidLicenseState(result) {
  const reason  = result.reason || result.status || 'unknown';
  const message = LICENSE_STATE_MESSAGES[reason] || 'Your license is no longer valid. Visit ghostcoachai.com.';

  // Stop coaching immediately
  if (isCoaching) stopCoaching();

  // Show overlay notification
  sendToOverlay('coach:tip', {
    text:     message,
    type:     'warning',
    priority: 'high',
  });

  // Clear stored license so activation screen shows on next launch
  store.set('licenseKey',    '');
  store.set('licenseStatus', '');
  store.set('licensePlan',   '');
  store.set('licenseExpiry', '');

  console.warn(`[license] Invalid state: ${reason} — coaching stopped, license cleared`);
}

// ─── Performance interval — minimum 20s to avoid lag spikes ───────────────────
function getBaseInterval() {
  return 20000; // fixed 20s — do not lower
}

// ─── Capture + Analysis ────────────────────────────────────────────────────────
async function runCapture(forced = false) {
  const licenseKey = store.get('licenseKey');
  if (!licenseKey || isPaused) return;

  // In-flight guard — never send while a request is in progress
  if (requestInFlight) return;

  const now = Date.now();
  const secondsSinceLast = ((now - lastCapture) / 1000).toFixed(1);

  // 20s minimum between captures; 25s after a tip was shown
  const minGap     = getBaseInterval(); // 20 000ms
  const tipCooldown = now - lastTipTime < 25000;

  if (!forced && (now - lastCapture < minGap || tipCooldown)) return;

  console.log('[capture] Taking screenshot. Last capture was', secondsSinceLast, 'seconds ago');
  lastCapture = now;
  captureCount++;

  const overlayWin = getOverlayWindow();

  try {
    requestInFlight = true;
    sendToOverlay('coach:status', { status: 'capturing' });
    sendToSettings('settings:status', { status: 'capturing' });

    // Hide overlay before capture to avoid overlay in screenshot
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(0);
    await new Promise(r => setTimeout(r, 50)); // 50ms settle time

    const { buffer, hash, sizeKB } = await captureScreen();

    // Restore overlay immediately
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(1);

    // Skip if frame hasn't changed
    if (!forced && hash === lastScreenHash) {
      console.log('[capture] Duplicate frame skipped');
      sendToOverlay('coach:status', { status: 'coaching' });
      requestInFlight = false;
      return;
    }
    lastScreenHash = hash;

    sendToOverlay('coach:status', { status: 'analyzing' });
    sendToSettings('settings:status', { status: 'analyzing' });

    const result = await analyzeScreenshot(buffer, licenseKey, 'smart', false, [], hash);

    // SKIP or empty/garbage — not gameplay
    if (!result || result.trim().length < 8 || result.trim().toUpperCase() === 'SKIP') {
      sendToOverlay('coach:status', { status: 'coaching' });
      sendToSettings('settings:status', { status: 'coaching' });
      requestInFlight = false;
      return;
    }

    // Truncate very long responses to first sentence
    let tipText = result.trim();
    if (tipText.length > 120) {
      const first = tipText.match(/^[^.!?]+[.!?]/);
      tipText = first ? first[0].trim() : tipText.substring(0, 100).trim();
    }

    // Skip duplicate tips
    if (isDuplicateTip(tipText, matchTipsForSummary.slice(-10))) {
      sendToOverlay('coach:status', { status: 'coaching' });
      requestInFlight = false;
      return;
    }

    lastTipTime = now;
    const tipData = { text: tipText, game: 'Valorant', timestamp: Date.now(), isDeathTip: false };
    tipHistory.unshift(tipData);
    if (tipHistory.length > 20) tipHistory.pop();
    matchTipsForSummary.push(tipText);

    sendToOverlay('coach:tip', tipData);
    sendToOverlay('coach:state', buildState());
    sendToOverlay('coach:status', { status: 'coaching' });
    sendToSettings('settings:state', buildState());
    sendToSettings('settings:status', { status: 'coaching' });
    requestInFlight = false;

  } catch (err) {
    requestInFlight = false;
    if (overlayWin && !overlayWin.isDestroyed()) {
      try { overlayWin.setOpacity(1); } catch (_) {}
    }
    const msg = err.message || '';
    let errStatus;
    if (msg.includes('timeout') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
      errStatus = { status: 'connection_lost' };
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
async function triggerRoundSummary(buffer, licenseKey) {
  try {
    const sumStatus = { status: 'summarizing' };
    sendToOverlay('coach:status', sumStatus);
    sendToSettings('settings:status', sumStatus);
    const summary = await getRoundSummary(buffer, licenseKey);
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
async function triggerMatchSummary(licenseKey) {
  if (matchTipsForSummary.length < 3) return;
  const tips = [...matchTipsForSummary];
  matchTipsForSummary = [];

  try {
    const summary = await getMatchSummary(tips, licenseKey);
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
  deathTipSent    = false;
  combatTipGiven  = false;
  requestInFlight = false;
  lastTipTime     = 0;
  lastScreenHash  = '';

  // Start in_match immediately — no separate match detection step
  matchState = 'in_match';
  sendToOverlay('coach:matchState', { state: 'in_match' });

  // 10-second warmup so the game can stabilize FPS before first screenshot
  setTimeout(() => {
    if (isCoaching && !isPaused) runCapture(true);
  }, 10000);

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

  deathTipSent    = false;
  combatTipGiven  = false;
  requestInFlight = false;
  lastScreenHash  = '';
  matchState      = 'idle';
  playerState     = 'alive';
  sessionStartTime = null;
  captureCount    = 0;

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
  const licenseKey = store.get('licenseKey');
  if (!licenseKey) return;
  const overlayWin = getOverlayWindow();
  if (overlayWin) overlayWin.setOpacity(0);
  await new Promise(r => setTimeout(r, 20));
  const { buffer } = await captureScreen();
  if (overlayWin) overlayWin.setOpacity(1);
  triggerRoundSummary(buffer, licenseKey);
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
    // Use /activate endpoint — handles device locking on first activation
    const result = await activateLicenseWithServer(key);

    if (result.valid) {
      store.set('licenseKey',    key.trim().toUpperCase());
      store.set('licenseStatus', result.status   || 'active');
      store.set('licensePlan',   result.plan     || '');
      store.set('licenseExpiry', result.expiresAt || '');
      store.set('deviceId',      getDeviceId());

      if (activationWindow && !activationWindow.isDestroyed()) activationWindow.close();
      launchMainApp();
    }

    // Return friendly message for known invalid states
    if (!result.valid && result.reason) {
      result.error = LICENSE_STATE_MESSAGES[result.reason] || result.error;
    }

    return result;
  } catch (err) {
    console.error('[activate] Validation error:', err.message);

    // Offline grace: allow entry if cached key matches and hasn't expired
    const cachedKey    = store.get('licenseKey');
    const cachedStatus = store.get('licenseStatus');
    const cachedExpiry = store.get('licenseExpiry');
    const cachedDevice = store.get('deviceId');

    if (cachedKey && cachedKey.toUpperCase() === key.trim().toUpperCase() &&
        cachedStatus === 'active' && cachedDevice === getDeviceId()) {
      const expired = cachedExpiry ? new Date(cachedExpiry) < new Date() : false;
      if (!expired) {
        console.log('[activate] Server unreachable — using cached license');
        if (activationWindow && !activationWindow.isDestroyed()) activationWindow.close();
        launchMainApp();
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

app.whenReady().then(async () => {
  const licenseKey    = store.get('licenseKey');
  const licenseStatus = store.get('licenseStatus');
  const licenseExpiry = store.get('licenseExpiry');

  // Local validity check (fast path — no network)
  const locallyValid = licenseKey &&
    licenseStatus === 'active' &&
    (!licenseExpiry || new Date(licenseExpiry) > new Date());

  if (!locallyValid) {
    createActivationWindow();
    return;
  }

  // Server-side re-validation on every launch (device check + expiry)
  try {
    const result = await validateLicenseWithServer(licenseKey);
    if (!result.valid) {
      // Handle expired/cancelled/device_mismatch — clear license and show activation
      const reason  = result.reason || result.status || 'unknown';
      const message = LICENSE_STATE_MESSAGES[reason];
      console.warn(`[startup] License invalid on server: ${reason}`);
      store.set('licenseKey',    '');
      store.set('licenseStatus', '');
      store.set('licensePlan',   '');
      store.set('licenseExpiry', '');
      createActivationWindow();
      // Show error message in activation window once it loads
      if (message) {
        const win = activationWindow;
        if (win) win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) win.webContents.send('activate:serverMessage', message);
        });
      }
      return;
    }
    // Update cached values from server response
    store.set('licenseStatus', result.status   || 'active');
    store.set('licensePlan',   result.plan     || store.get('licensePlan'));
    store.set('licenseExpiry', result.expiresAt || licenseExpiry);
  } catch (err) {
    // Network error — allow offline grace, proceed with cached license
    console.warn('[startup] Server unreachable, using cached license:', err.message);
  }

  launchMainApp();
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
