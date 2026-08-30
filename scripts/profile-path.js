'use strict';

/**
 * Where a real player profile lives on this machine.
 *
 * The folder moved from "%APPDATA%\GhostCoach 2.0" to "%APPDATA%\Occlara", and
 * the store file inside it from ghostcoach-config.json to occlara-config.json.
 * Dev scripts read an actual installed profile (verify:ai grades a real session,
 * review:log reads real AI logs), so they have to find it on EITHER side of that
 * move: whoever is running them may still have an older build installed, which
 * has not migrated yet and never will until it is launched.
 *
 * Prefers the new location, falls back to the old, and returns the new one when
 * neither exists so callers report a sensible path in their "not found" message.
 */
const fs = require('fs');
const path = require('path');

function firstThatExists(candidates) {
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return candidates[0];
}

function profileDir(appData) {
  const base = appData || process.env.APPDATA || '';
  return firstThatExists([
    path.join(base, 'Occlara'),
    path.join(base, 'GhostCoach 2.0'),
  ]);
}

function configPath(dir) {
  const root = dir || profileDir();
  return firstThatExists([
    path.join(root, 'occlara-config.json'),
    path.join(root, 'ghostcoach-config.json'),
  ]);
}

module.exports = { profileDir, configPath };
