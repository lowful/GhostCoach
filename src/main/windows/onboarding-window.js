'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');
const store = require('../services/store');

/**
 * One-time welcome card shown right after the first successful activation:
 * a 20-second tour (start coaching, confirm agent, tips appear), the
 * fundamental-tips question, + hotkeys.
 * Never shown again once dismissed (onboardingCompleted flag).
 */
function create() {
  const existing = registry.get('onboarding');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    width:  480,
    height: 940,   // fits the 4-step tour + the fundamental-tips question
    frame:       false,
    resizable:   false,
    transparent: true,
    center:      true,
    skipTaskbar: false,
    alwaysOnTop: true,
    show:        false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // false so the preload can require the shared channels registry
      preload: path.join(__dirname, '../../preload/onboarding-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/onboarding/index.html'));
  win.once('ready-to-show', () => win.show());
  // However it closes, don't show it again.
  win.on('closed', () => store.set('onboardingCompleted', true));

  registry.register('onboarding', win);
  return win;
}

function close() {
  const win = registry.get('onboarding');
  if (win) win.close();
}

module.exports = { create, close };
