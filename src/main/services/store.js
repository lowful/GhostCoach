'use strict';

const Store = require('electron-store');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { STORE_DEFAULTS } = require('../../shared/config');

/**
 * Thin wrapper over electron-store with our defaults baked in.
 * Single shared instance for the whole main process.
 *
 * Survives a corrupt config file. conf (electron-store's backing library)
 * defaults clearInvalidConfig to FALSE, so a config that fails to parse throws
 * straight out of the constructor. That happens at module load, before the
 * logger or any window exists, so the app died to a bare Electron error dialog
 * with nothing written to debug.log and no way for the player to recover short
 * of finding and deleting a file inside %APPDATA%. A half-written file from an
 * unclean shutdown, or anything that prepends a byte order mark, was enough to
 * brick the install permanently.
 *
 * Now: settings reset to defaults instead, the bad file is kept alongside for
 * diagnosis, and in the worst case the app still starts on an in-memory store.
 */
const OPTIONS = { name: 'ghostcoach-config', defaults: STORE_DEFAULTS, clearInvalidConfig: true };

function configPath() {
  try { return path.join(app.getPath('userData'), OPTIONS.name + '.json'); }
  catch { return null; }
}

/** Keep the unreadable file so it can be inspected, rather than deleting it. */
function quarantine() {
  const p = configPath();
  if (!p) return;
  try {
    if (fs.existsSync(p)) {
      const dead = p + '.corrupt-' + Date.now();
      fs.renameSync(p, dead);
      console.error('[store] config was unreadable, moved to', path.basename(dead));
    }
  } catch (e) {
    try { fs.unlinkSync(p); } catch {}
  }
}

/** Last resort: the app runs with defaults for this session, nothing persists. */
function memoryStore() {
  const data = { ...STORE_DEFAULTS };
  return {
    get: (k, d) => (data[k] !== undefined ? data[k] : d),
    set: (k, v) => { if (typeof k === 'object') Object.assign(data, k); else data[k] = v; },
    delete: (k) => { delete data[k]; },
    clear: () => { for (const k of Object.keys(data)) delete data[k]; },
    has: (k) => data[k] !== undefined,
    get store() { return data; },
  };
}

function build() {
  try {
    return new Store(OPTIONS);
  } catch (err) {
    console.error('[store] could not open config:', err.message);
    quarantine();
    try {
      return new Store(OPTIONS);   // fresh file, defaults restored
    } catch (err2) {
      console.error('[store] config unusable, running from memory:', err2.message);
      return memoryStore();
    }
  }
}

module.exports = build();
