'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Move the player's profile from the pre-rename folder to the current one.
 *
 * The product was GhostCoach and is now Occlara, and the profile folder holds
 * the licence, every setting, the session archive, the AI logs and the match
 * summaries. Renaming the folder without moving what is inside it points the
 * new build at an empty directory, which to a player is indistinguishable from
 * the app having wiped their account.
 *
 * THE RULE HERE IS: NEVER LOSE DATA. Every failure path keeps using the old
 * folder and lets the app carry on. A build quietly running on the previous
 * path is a non-event that the next launch can retry; a half-moved profile is a
 * support ticket about a vanished licence. That is why nothing is ever deleted
 * and why a failed config rename puts the whole folder back.
 *
 * Must run BEFORE app.setPath and before anything opens a file in the profile:
 * electron-store writes its config on first read, which would otherwise create
 * a fresh empty profile at the new path while the real one still sat at the old
 * one, and then the two would both exist and neither would be right.
 *
 * WHICH MEANS IT ALSO RUNS BEFORE THE SINGLE INSTANCE LOCK, and that cannot be
 * reordered: Electron keeps the lock file inside userData, so the lock can only
 * be requested after setPath. A second copy launched while the app is already
 * running therefore reaches this code and tries to move a profile that the
 * first copy has open. Windows is what stops it, refusing the rename with
 * EPERM while handles are held, and the catch below then keeps the second copy
 * on the old folder, which is the same folder the running copy is using. It
 * quits a moment later on the lock. Observed, not theorised: launching a second
 * instance during development did exactly this.
 *
 * So do not "fix" the ordering by moving the lock earlier, and do not treat a
 * failed rename as an error worth surfacing. Both are load bearing.
 *
 * @param {string} legacyDir  the pre-rename folder
 * @param {string} newDir     the folder to move to
 * @param {object} [io]       injection seam for tests and logging
 * @returns {string} the directory the caller should actually use
 */
function migrate(legacyDir, newDir, io) {
  const log  = (io && io.log)  || (() => {});
  const warn = (io && io.warn) || (() => {});

  try {
    // Already migrated, or a fresh install. Merging two profiles is not
    // something to guess at, so if the destination exists it wins outright.
    if (fs.existsSync(newDir)) return newDir;
    // Nothing to carry over: a first run on a machine that never had the old
    // build. The caller creates the folder as usual.
    if (!fs.existsSync(legacyDir)) return newDir;

    // Atomic within a volume: it either fully happens or it does not.
    fs.renameSync(legacyDir, newDir);

    // The store file is named, not fixed, so it travels with the folder and
    // then needs its own rename to match the new store name. Getting this wrong
    // costs the licence and every setting, so a failure puts the folder back
    // rather than leaving a profile the new build cannot read.
    const oldCfg = path.join(newDir, 'ghostcoach-config.json');
    const newCfg = path.join(newDir, 'occlara-config.json');
    if (fs.existsSync(oldCfg) && !fs.existsSync(newCfg)) {
      try {
        fs.renameSync(oldCfg, newCfg);
      } catch (err) {
        try { fs.renameSync(newDir, legacyDir); } catch {}
        warn('[profile] config rename failed, staying on the old folder: ' + err.message);
        return legacyDir;
      }
    }

    log('[profile] moved the profile to ' + path.basename(newDir));
    return newDir;
  } catch (err) {
    warn('[profile] move failed, continuing on the old folder: ' + err.message);
    return legacyDir;
  }
}

module.exports = { migrate };
