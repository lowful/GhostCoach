'use strict';

/**
 * Reading the AI decision log: list the kept sessions, open one of them.
 *
 * Split out from the writer so it can be tested without Electron, because the
 * two rules that matter here are both invisible when they break:
 *
 *   - the picker must NOT carry frames. A session holds 2 to 12MB of JPEG,
 *     which base64 inflates by a third again, so listing five sessions eagerly
 *     would push 30MB+ through a single IPC call to fill a dropdown. Metadata
 *     comes from log.json alone, at roughly 50 to 100KB a session.
 *   - the session id arrives from a renderer, so it is matched against the
 *     folder listing rather than joined onto a path.
 *
 * Every function takes the root explicitly and keeps no state, so a test can
 * point it at a fixture directory.
 */
const fs = require('fs');
const path = require('path');
const timeline = require('./ai-log-timeline');

/** Session folders that actually have an index, newest first. */
function dirs(root) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((f) => /^session-/.test(f) && fs.existsSync(path.join(root, f, 'log.json')))
    .map((f) => ({ f, t: fs.statSync(path.join(root, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((d) => d.f);
}

/** Recover the start time from a folder name, since the stamp is an ISO string
 *  with its colons and dot swapped for dashes to be a legal path. Only needed
 *  when a session holds no records to read a timestamp from. */
function startedAt(id) {
  const m = /^session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(String(id));
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) || 0 : 0;
}

function records(root, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, id, 'log.json'), 'utf8')).records || [];
  } catch { return []; }
}

/** Metadata for every kept session, and NO frames. This is the picker's list. */
function sessions(root, liveId) {
  try {
    return dirs(root).map((id) => {
      const recs = records(root, id);
      const first = recs[0] || {};
      const last = recs[recs.length - 1] || {};
      return {
        id,
        at: first.at || startedAt(id),
        frames: recs.length,
        deaths: recs.filter((r) => r.shown && r.shown.death).length,
        // CONFIRMED maps, not the raw reads. Listing what the model said would
        // label all five real sessions on this machine with two or three maps
        // each, when every one of them was a single map from start to finish.
        maps: timeline.mapsPlayed(recs),
        mins: first.at && last.at ? Math.max(1, Math.round((last.at - first.at) / 60000)) : 0,
        live: !!liveId && id === liveId,
      };
    });
  } catch { return []; }
}

/**
 * One session with its frames inlined as data URIs, so the viewer needs no file
 * access. Defaults to the newest, and an unknown id falls back to the newest
 * rather than failing, because a session can be pruned while its window is open.
 */
function read(root, id, liveId) {
  try {
    const list = dirs(root);
    if (!list.length) return { records: [], sessions: [] };
    const chosen = list.includes(String(id)) ? String(id) : list[0];
    const dir = path.join(root, chosen);
    const recs = records(root, chosen);
    for (const r of recs) {
      try {
        r.frameData = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, r.frame)).toString('base64');
      } catch { r.frameData = null; }
    }
    return {
      session: chosen,
      sessions: sessions(root, liveId),
      records: recs,
      // Where the map actually changed, so the scrubber can mark it. Computed
      // once here rather than in the renderer, because it needs the callout
      // fingerprint from the engine and a renderer has no Node access.
      segments: timeline.segments(recs).map((s) => ({
        from: s.from, to: s.to, map: s.map, confirmed: s.confirmed,
        byModel: s.byModel, byLabel: s.byLabel, labels: s.labels,
      })),
      // Every death, not just the ones the coach spoke about. The two differ by
      // design, since the engine caps review tips and then goes quiet, so the
      // marks used to stop at the coaching and leave real deaths unfindable.
      deaths: timeline.deaths(recs),
      deathCheck: timeline.deathSanity(recs),
    };
  } catch (e) {
    return { records: [], sessions: [], error: e.message };
  }
}

/** Keep only the most recent session folders. */
function prune(root, keep) {
  try {
    for (const id of dirs(root).slice(keep)) {
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
    }
  } catch {}
}

module.exports = { dirs, sessions, read, prune, startedAt };
