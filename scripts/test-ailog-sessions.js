'use strict';

/**
 * The AI log's session browser, against a fixture directory.
 *
 * Three of these guard failures that produce a confident, wrong-looking-right
 * result rather than an error:
 *
 *   - listing sessions must not read frames. If it ever does, filling a dropdown
 *     costs 30MB+ of base64 through one IPC call and the window hangs on open
 *     with nothing in the log to say why.
 *   - the session id comes from a renderer. Joined onto a path unchecked, "../"
 *     reads outside the log folder entirely.
 *   - an unknown id must fall back to the newest session, because pruning can
 *     delete the session whose window is open.
 *
 * Run: npm run test:ailog
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'main', 'services', 'ai-log-store.js'));

let fails = 0;
const ok = (cond, what) => { if (!cond) { fails++; console.log(`FAIL  ${what}`); } else console.log(`ok    ${what}`); };

// ── Fixture ─────────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-ailog-'));
const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');   // enough to be a file

function makeSession(stamp, recs, mtime) {
  const dir = path.join(root, `session-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const records = recs.map((r, i) => {
    const frame = `frame-${String(i).padStart(4, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, frame), jpeg);
    return { i, at: r.at, frame, state: r.state || {}, aiTip: '', shown: r.shown || null, reject: null };
  });
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify({ startedAt: records[0] && records[0].at, records }));
  fs.utimesSync(dir, mtime / 1000, mtime / 1000);
  return dir;
}

const T = Date.UTC(2026, 7, 10, 20, 0, 0);
makeSession('2026-08-10T20-00-00-000Z', [
  { at: T, state: { map: 'Bind', locLabel: 'Hookah' } },
  { at: T + 600000, state: { map: 'Bind', locLabel: 'Showers' }, shown: { text: 'died', death: true } },
], T);
makeSession('2026-08-12T21-35-10-405Z', [
  { at: T + 86400000, state: { map: 'Haven' } },
  { at: T + 86400000, state: { map: 'Lotus' } },
  { at: T + 86400000, state: { map: 'Abyss' } },
], T + 86400000);
// A session whose records were never written: it must still list, not crash.
const empty = path.join(root, 'session-2026-08-13T10-00-00-000Z');
fs.mkdirSync(empty);
fs.writeFileSync(path.join(empty, 'log.json'), JSON.stringify({ records: [] }));
fs.utimesSync(empty, (T + 172800000) / 1000, (T + 172800000) / 1000);
// A folder with no index at all is not a session.
fs.mkdirSync(path.join(root, 'session-broken'));

// ── Listing ─────────────────────────────────────────────────────────────────
const list = store.sessions(root, 'session-2026-08-12T21-35-10-405Z');
ok(list.length === 3, `lists the 3 real sessions and skips the index-less one (got ${list.length})`);
ok(list[0].id === 'session-2026-08-13T10-00-00-000Z', 'newest session comes first');

// THE size rule. Metadata carries counts, never pictures.
const listJson = JSON.stringify(list);
ok(!/frameData|base64|data:image/.test(listJson), 'the session list carries NO frame data');
ok(listJson.length < 2000, `the session list stays small (${listJson.length} bytes)`);

const bind = list.find((s) => s.id === 'session-2026-08-10T20-00-00-000Z');
ok(bind.frames === 2 && bind.deaths === 1, 'frame and death counts are right');
ok(bind.mins === 10, `duration is read from the records (${bind.mins} min)`);
ok(bind.live === false, 'a finished session is not marked live');

// THE BUG THIS ASSERTION EXISTS FOR. This session's three frames each name a
// different map, which is what a real session looks like when the model
// flickers. Listing the raw reads labelled all five real sessions on this
// machine with two or three maps when every one of them was a single map, so a
// map must be corroborated before it is named at all.
const multi = list.find((s) => s.id === 'session-2026-08-12T21-35-10-405Z');
ok(multi.maps.length === 0, `three contradictory one-frame reads name no map (got ${JSON.stringify(multi.maps)})`);
ok(multi.live === true, 'the session being written is marked live');

// A session with a plurality and agreeing callouts DOES get named.
ok(bind.maps.join() === 'Bind', `a corroborated map is named (${JSON.stringify(bind.maps)})`);

// An empty session still gets a time, recovered from its folder name.
const blank = list.find((s) => s.id === 'session-2026-08-13T10-00-00-000Z');
ok(blank.frames === 0 && blank.at === Date.UTC(2026, 7, 13, 10, 0, 0),
  'an empty session lists with a time recovered from its folder name');

// ── Opening one ─────────────────────────────────────────────────────────────
const newest = store.read(root);
ok(newest.session === 'session-2026-08-13T10-00-00-000Z', 'no id opens the newest session');

const chosen = store.read(root, 'session-2026-08-10T20-00-00-000Z');
ok(chosen.session === 'session-2026-08-10T20-00-00-000Z', 'an id opens that session');
ok(chosen.records.length === 2, 'its records come back');
ok(String(chosen.records[0].frameData).startsWith('data:image/jpeg;base64,'),
  'frames ARE inlined when a session is opened');
ok(Array.isArray(chosen.sessions) && chosen.sessions.length === 3,
  'opening a session also returns the list, so the picker repaints');

// ── The id is untrusted ─────────────────────────────────────────────────────
for (const bad of ['../../secrets', '..\\..\\secrets', '/etc/passwd', 'session-2026-08-10T20-00-00-000Z/../..', '']) {
  const r = store.read(root, bad);
  ok(store.dirs(root).includes(r.session),
    `a crafted id (${JSON.stringify(bad)}) falls back to a real session, not a path`);
}
ok(store.read(root, 'session-deleted-while-open').session === store.dirs(root)[0],
  'a pruned session falls back to the newest rather than failing');

// ── Pruning keeps the newest ────────────────────────────────────────────────
// A frameless session leaves a folder with no log.json. dirs() skips those on
// purpose, so a prune built on dirs() can never see them and they pile up
// forever in the one directory that exists to stay bounded. The app creates one
// every time it starts and stops before capturing a frame.
ok(fs.existsSync(path.join(root, 'session-broken')), 'the index-less folder is still on disk before pruning');
store.prune(root, 2);
const left = store.dirs(root);
ok(left.length === 2 && left[0] === 'session-2026-08-13T10-00-00-000Z',
  `prune keeps the 2 newest (${left.join(', ')})`);
ok(!fs.existsSync(path.join(root, 'session-broken')), 'and prune removes the frameless folder it cannot index');

// ── Missing root ────────────────────────────────────────────────────────────
ok(store.sessions(path.join(root, 'nope')).length === 0, 'a missing log folder lists nothing');
ok(store.read(path.join(root, 'nope')).records.length === 0, 'a missing log folder reads nothing');

fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `\n${fails} failure(s)` : '\nall ai-log session checks passed');
process.exit(fails ? 1 : 0);
