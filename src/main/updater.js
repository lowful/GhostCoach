'use strict';

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

/**
 * Auto-updates. Checks the public releases feed the moment the app opens and
 * every 6 hours after, downloads new versions silently in the background
 * (differential via the blockmap, so updates are small), then prompts the
 * player from the app: restart now, or later, in which case the update
 * installs on next quit.
 *
 * Only runs in the packaged app; `npm start` dev sessions never check.
 * Every failure path is log-only: an update problem must never affect
 * coaching.
 */
let prompted = false;
// Surfaced in Settings next to the version, so the player can see at a glance
// whether they are current instead of guessing whether an update landed.
let status = { state: 'idle', version: null, checkedAt: 0 };

function getStatus() {
  return { ...status, current: app.getVersion(), packaged: app.isPackaged };
}

function init() {
  if (!app.isPackaged) {
    status = { state: 'dev', version: null, checkedAt: Date.now() };
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // "Later" still applies it on quit
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => { status = { ...status, state: 'checking' }; });

  autoUpdater.on('update-not-available', () => {
    status = { state: 'current', version: null, checkedAt: Date.now() };
  });

  autoUpdater.on('update-available', (info) => {
    status = { state: 'downloading', version: info.version, checkedAt: Date.now() };
    console.log('[updater] update available:', info.version, '(downloading in background)');
  });

  autoUpdater.on('update-downloaded', async (info) => {
    status = { state: 'ready', version: info.version, checkedAt: Date.now() };
    if (prompted) return;   // one prompt per downloaded version
    prompted = true;
    console.log('[updater] update downloaded:', info.version);
    try {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'Occlara update ready',
        message: `Occlara ${info.version} is ready to install.`,
        detail: 'Restart now to update, or keep playing and it installs when you close the app.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) {
        setImmediate(() => autoUpdater.quitAndInstall());
      }
    } catch (e) {
      console.error('[updater] prompt failed:', e.message);
    }
  });

  autoUpdater.on('error', (err) => {
    // Offline, feed unreachable, rate limited: all fine, try again later.
    status = { ...status, state: 'offline', checkedAt: Date.now() };
    console.log('[updater] check failed (will retry):', err == null ? 'unknown' : err.message);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();                                     // the moment the app opens
  setInterval(check, 6 * 60 * 60 * 1000);      // and every 6 hours
}

/** Settings "check now": forces a fresh look at the feed. */
function checkNow() {
  if (!app.isPackaged) return Promise.resolve(getStatus());
  status = { ...status, state: 'checking' };
  return autoUpdater.checkForUpdates().catch(() => {}).then(() => getStatus());
}

module.exports = { init, getStatus, checkNow };
