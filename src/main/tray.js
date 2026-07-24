'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs   = require('fs');

/**
 * System tray. `actions` injects the handlers so the tray stays decoupled from
 * the coaching controller.
 */
let tray = null;

function create(actions) {
  try {
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    const icon = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
      : nativeImage.createEmpty();

    tray = new Tray(icon);
    tray.setToolTip('GhostCoach');
    update(false, actions);
    tray.on('double-click', () => actions.toggleOverlay());
  } catch (err) {
    console.warn('[tray] Could not create tray:', err.message);
  }
  return tray;
}

function update(isCoaching, actions) {
  if (!tray) return;
  const panelHidden = actions.isMinimized && actions.isMinimized();
  const menu = Menu.buildFromTemplate([
    { label: isCoaching ? 'Stop Coaching' : 'Start Coaching',
      click: () => (isCoaching ? actions.stop() : actions.start()) },
    { label: panelHidden ? 'Show Panel' : 'Hide Panel', click: () => actions.toggleMinimize() },
    { label: 'Show / Hide Overlay', click: () => actions.toggleOverlay() },
    { label: 'Weekly Report…',      click: () => actions.openWeekly() },
    { label: 'Tip History…',        click: () => actions.openHistory() },
    { label: 'Settings…',           click: () => actions.openSettings() },
    { type: 'separator' },
    { label: 'Quit GhostCoach',     click: () => actions.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(isCoaching ? 'GhostCoach, Coaching' : 'GhostCoach');
}

function destroy() {
  if (tray) { tray.destroy(); tray = null; }
}

module.exports = { create, update, destroy };
