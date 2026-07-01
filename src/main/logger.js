'use strict';

const path = require('path');
const fs   = require('fs');

/**
 * Tees console.{log,warn,error} to %APPDATA%\ghostcoach\debug.log.
 * Main-process stdout is invisible in installed builds, so this is the only
 * way to debug production. Truncated on each launch.
 */
let logPath = null;

function init(app) {
  try {
    logPath = path.join(app.getPath('userData'), 'debug.log');
    try {
      fs.writeFileSync(logPath, `=== GhostCoach session ${new Date().toISOString()} ===\n`);
    } catch {}

    const wrap = (level, orig) => (...args) => {
      try {
        const line = `[${new Date().toISOString()}] [${level}] ` +
          args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ') + '\n';
        fs.appendFileSync(logPath, line);
      } catch {}
      orig(...args);
    };

    console.log   = wrap('log',   console.log.bind(console));
    console.warn  = wrap('warn',  console.warn.bind(console));
    console.error = wrap('error', console.error.bind(console));
  } catch {}
  return logPath;
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

function getLogPath() { return logPath; }

module.exports = { init, getLogPath };
