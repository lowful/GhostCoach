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

function init() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // "Later" still applies it on quit
  autoUpdater.logger = console;

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version, '(downloading in background)');
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (prompted) return;   // one prompt per downloaded version
    prompted = true;
    console.log('[updater] update downloaded:', info.version);
    try {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'GhostCoach update ready',
        message: `GhostCoach ${info.version} is ready to install.`,
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
    console.log('[updater] check failed (will retry):', err == null ? 'unknown' : err.message);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();                                     // the moment the app opens
  setInterval(check, 6 * 60 * 60 * 1000);      // and every 6 hours
}

module.exports = { init };
