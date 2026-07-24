'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const registry = require('./registry');

/**
 * AI decision-log viewer: scrub through the frames the coach read this session,
 * each paired with the STATE it parsed and the tip it gave, to see what went
 * wrong. Larger than the other popups because it shows a screenshot.
 */
function open() {
  const existing = registry.get('ailog');
  if (existing) { existing.focus(); return existing; }

  const win = new BrowserWindow({
    width:  900,
    height: 640,
    frame:       false,
    resizable:   true,
    minWidth:    640,
    minHeight:   460,
    transparent: false,
    center:      true,
    backgroundColor: '#0b1119',
    show:        false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      preload: path.join(__dirname, '../../preload/ailog-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/ailog/index.html'));
  win.once('ready-to-show', () => win.show());

  registry.register('ailog', win);
  return win;
}

function get() { return registry.get('ailog'); }

module.exports = { open, get };
