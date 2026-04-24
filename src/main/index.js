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
const { createSettingsWindow, sendToSettings } = require('./settings-window');
const { captureScreenshot } = require('./capture');

const { registerHotkeys, unregisterHotkeys } = require('./hotkeys');
const CoachingEngine = require('./coaching-engine');

// ─── Session State ─────────────────────────────────────────────────────────────
let activationWindow = null;
let isCoaching       = false;
let isPaused         = false;
let setupWindow      = null;
let tipHistory       = [];   // all tips this session
let roundSummaries   = [];   // round summaries this session
let sessionStartTime = null;
let engine           = null; // CoachingEngine instance

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
  sendToOverlay('show-tip', {
    text:   message,
    source: 'system',
    time:   Date.now(),
  });

  // Clear stored license so activation screen shows on next launch
  store.set('licenseKey',    '');
  store.set('licenseStatus', '');
  store.set('licensePlan',   '');
  store.set('licenseExpiry', '');

  console.warn(`[license] Invalid state: ${reason} — coaching stopped, license cleared`);
}

// ─── Coaching Loop ─────────────────────────────────────────────────────────────
function startCoaching() {
  if (isCoaching) return;
  isCoaching       = true;
  isPaused         = false;
  sessionStartTime = Date.now();
  tipHistory       = [];

  // Strip trailing /api from stored URL so engine can append its own paths
  const rawUrl = store.get('serverUrl') || 'https://ghostcoach-production.up.railway.app/api';
  const baseUrl = rawUrl.replace(/\/api\/?$/, '');

  engine = new CoachingEngine({
    serverUrl:       baseUrl,
    licenseKey:      store.get('licenseKey') || '',
    captureFunction: captureScreenshot,
  });

  engine.on('tip', (tipData) => {
    tipHistory.unshift(tipData);
    if (tipHistory.length > 40) tipHistory.pop();
    sendToOverlay('show-tip', tipData);
    sendToOverlay('coach:state', buildState());
    sendToSettings('settings:state', buildState());
  });

  engine.on('status', (status) => {
    sendToOverlay('coach:status', { status });
    sendToSettings('settings:status', { status });
  });

  engine.on('match-review', (review) => {
    const data = { review, game: 'Valorant', timestamp: Date.now(), tipsCount: tipHistory.length };
    saveMatchSummary(data);
    sendToOverlay('coach:matchReview', data);
  });

  engine.start();

  updateTrayMenu(true);
  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToSettings('settings:state', state);
  console.log('[coach] Started');
}

function stopCoaching() {
  if (!isCoaching) return;
  isCoaching = false;
  isPaused   = false;

  if (engine) {
    engine.stop();
    engine = null;
  }

  sendToOverlay('coach:sessionOver', {
    tipsCount: tipHistory.length,
    sessionStart: sessionStartTime
  });

  sessionStartTime = null;

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
    if (engine) engine.requestTip();
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
    game:                'Valorant',
    tipPos:              store.get('tipPosition'),
    overlayPosition:     store.get('overlayPosition'),
    performanceMode:     store.get('performanceMode'),
    onboardingCompleted: store.get('onboardingCompleted'),
    history:             tipHistory,
    summaries:           roundSummaries,
    sessionStart:        sessionStartTime,
    tipCount:            tipHistory.length,
    panelMinimized:      store.get('panelMinimized'),
    licensePlan:         store.get('licensePlan'),
    licenseStatus:       store.get('licenseStatus'),
    licenseExpiry:       store.get('licenseExpiry'),
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
ipcMain.on('settings:forceCapture',   () => { if (engine) engine.requestTip(); });

ipcMain.on('settings:quit', () => {
  cleanup();
  app.quit();
});

ipcMain.on('settings:save', (_, settings) => {
  if (settings.tipPos)              store.set('tipPosition',       settings.tipPos);
  if (settings.overlayPosition)     store.set('overlayPosition',   settings.overlayPosition);
  if (settings.performanceMode)     store.set('performanceMode',   settings.performanceMode);

  const state = buildState();
  sendToOverlay('coach:state', state);
  sendToSettings('settings:state', state);
});

ipcMain.on('overlay:setInteractive', (_, v) => {
  const overlayWin = getOverlayWindow();
  if (overlayWin) overlayWin.setIgnoreMouseEvents(!v, { forward: true });
});

// Setup window
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
      if (engine) engine.requestTip();
      sendToOverlay('overlay:miniToast', { text: 'Scanning...' });
    },
    requestTip:      () => {
      if (engine) engine.requestTip();
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
    toggleHistory:   () => { sendToOverlay('overlay:toggleHistory', {}); },
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

  // POLISH 4: Launch immediately for fast startup, validate server in background
  launchMainApp();

  validateLicenseWithServer(licenseKey).then(result => {
    if (!result.valid) {
      const reason = result.reason || result.status || 'unknown';
      console.warn(`[startup] License invalid on server: ${reason}`);
      // Stop coaching and clear license — user will see warning tip
      handleInvalidLicenseState(result);
    } else {
      store.set('licenseStatus', result.status   || 'active');
      store.set('licensePlan',   result.plan     || store.get('licensePlan'));
      store.set('licenseExpiry', result.expiresAt || licenseExpiry);
    }
  }).catch(err => {
    console.warn('[startup] Server unreachable, using cached license:', err.message);
  });
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
