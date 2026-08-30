'use strict';

/**
 * The profile move is the one piece of startup that can destroy a paying
 * player's licence and their whole session history, so it is tested against
 * real directories on disk rather than reasoned about.
 *
 * What matters is not that the happy path works. It is that EVERY failure ends
 * with the data still readable somewhere, and that the returned path is the one
 * the data is actually in.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrate } = require('../src/main/services/profile-migration');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); return; }
  console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  failures++;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occlara-profile-'));
let n = 0;
function fresh() {
  const base = path.join(root, 'case-' + (++n));
  fs.mkdirSync(base, { recursive: true });
  return { legacy: path.join(base, 'GhostCoach 2.0'), next: path.join(base, 'Occlara') };
}
function seedLegacy(legacy, cfgName) {
  fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'ai-log'), { recursive: true });
  fs.writeFileSync(path.join(legacy, (cfgName || 'ghostcoach-config') + '.json'),
    JSON.stringify({ license: 'KEY-1234', riotId: 'player#na1' }));
  fs.writeFileSync(path.join(legacy, 'sessions', 's1.json'), '{"tips":3}');
}

console.log('[profile] migration behaviour');

// 1. The upgrade every existing user hits.
{
  const { legacy, next } = fresh();
  seedLegacy(legacy);
  const used = migrate(legacy, next);
  check('upgrade returns the new folder', used === next, used);
  check('upgrade moves the licence', fs.existsSync(path.join(next, 'occlara-config.json')));
  check('upgrade keeps the licence CONTENTS',
    JSON.parse(fs.readFileSync(path.join(next, 'occlara-config.json'), 'utf8')).license === 'KEY-1234');
  check('upgrade carries the session archive', fs.existsSync(path.join(next, 'sessions', 's1.json')));
  check('upgrade carries the ai log folder', fs.existsSync(path.join(next, 'ai-log')));
  check('upgrade leaves nothing at the old path', !fs.existsSync(legacy));
  check('upgrade drops the old config name', !fs.existsSync(path.join(next, 'ghostcoach-config.json')));
}

// 2. A clean machine. Nothing to move, and it must not invent the folder.
{
  const { legacy, next } = fresh();
  const used = migrate(legacy, next);
  check('fresh install returns the new folder', used === next, used);
  check('fresh install creates nothing itself', !fs.existsSync(next) && !fs.existsSync(legacy));
}

// 3. Second launch after a successful move. Must be inert.
{
  const { legacy, next } = fresh();
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(next, 'occlara-config.json'), '{"license":"NEW"}');
  const used = migrate(legacy, next);
  check('already migrated returns the new folder', used === next);
  check('already migrated does not touch the config',
    JSON.parse(fs.readFileSync(path.join(next, 'occlara-config.json'), 'utf8')).license === 'NEW');
}

// 4. BOTH folders exist. This is the case that could silently destroy a
//    profile, so the destination must win and the old one must survive intact
//    for manual recovery. Merging two profiles is not something to guess at.
{
  const { legacy, next } = fresh();
  seedLegacy(legacy);
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(next, 'occlara-config.json'), '{"license":"NEWER"}');
  const used = migrate(legacy, next);
  check('conflict prefers the new folder', used === next);
  check('conflict does not overwrite the new config',
    JSON.parse(fs.readFileSync(path.join(next, 'occlara-config.json'), 'utf8')).license === 'NEWER');
  check('conflict leaves the old profile intact for recovery',
    fs.existsSync(path.join(legacy, 'ghostcoach-config.json')));
}

// 5. An old profile that somehow already carries the new config name. The
//    rename must not clobber it, and everything still moves.
{
  const { legacy, next } = fresh();
  seedLegacy(legacy, 'occlara-config');
  fs.writeFileSync(path.join(legacy, 'ghostcoach-config.json'), '{"license":"STALE"}');
  const used = migrate(legacy, next);
  check('both config names: returns the new folder', used === next);
  check('both config names: keeps the new one',
    JSON.parse(fs.readFileSync(path.join(next, 'occlara-config.json'), 'utf8')).license === 'KEY-1234');
  check('both config names: does not delete the stale one',
    fs.existsSync(path.join(next, 'ghostcoach-config.json')));
}

// 6. The move itself fails. The app must keep running on the old folder rather
//    than booting into an empty profile and looking like it wiped the account.
{
  const { legacy } = fresh();
  seedLegacy(legacy);
  // A destination whose parent is a FILE, so mkdir/rename cannot succeed.
  const blocker = path.join(root, 'blocker-' + n);
  fs.writeFileSync(blocker, 'not a directory');
  const used = migrate(legacy, path.join(blocker, 'Occlara'));
  check('failed move falls back to the old folder', used === legacy, used);
  check('failed move leaves the licence readable',
    fs.existsSync(path.join(legacy, 'ghostcoach-config.json')));
}

fs.rmSync(root, { recursive: true, force: true });

if (failures) {
  console.log('\nFAIL: ' + failures + ' profile migration check(s) failed');
  process.exit(1);
}
console.log('\nPASS: the profile moves, and every failure keeps the data reachable');
