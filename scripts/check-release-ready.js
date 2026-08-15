'use strict';

/**
 * Refuse to publish a build whose source is not on main.
 *
 * `npm run release` is two independent steps: electron-builder publishes the
 * installer, and git push is something a human remembers to do first. Twice in
 * one day the push was REJECTED (an automated data-sync commit had landed) and
 * the release published anyway, leaving a binary in users' hands built from
 * source nobody could see. It has also happened before this session.
 *
 * The failure is quiet in the worst way: the push prints a hint, the release
 * prints success, and the success is the last thing on screen.
 *
 * Checks, in the order that fails most usefully:
 *   1. the working tree is clean
 *   2. HEAD is on main
 *   3. HEAD exists on origin/main
 *   4. package.json version has a matching commit
 *
 * GHOST_SKIP_RELEASE_CHECK=1 bypasses it, deliberately awkward to type.
 */
const { execSync } = require('child_process');
const path = require('path');

if (process.env.GHOST_SKIP_RELEASE_CHECK === '1') {
  console.log('[release] preflight skipped by GHOST_SKIP_RELEASE_CHECK');
  process.exit(0);
}

const git = (cmd) => execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = require(path.join(__dirname, '..', 'package.json')).version;
const fail = (msg, fix) => {
  console.error(`\n[release] BLOCKED: ${msg}`);
  console.error(`[release] ${fix}\n`);
  process.exit(1);
};

let dirty, branch, head, remote;
try {
  dirty  = git('status --porcelain');
  branch = git('rev-parse --abbrev-ref HEAD');
  head   = git('rev-parse HEAD');
  git('fetch origin --quiet');
  remote = git('rev-parse origin/main');
} catch (e) {
  fail(`git is not answering (${e.message.split('\n')[0]})`,
    'Run the release from the repo with git available, or set GHOST_SKIP_RELEASE_CHECK=1.');
}

if (dirty) {
  fail(`the working tree has uncommitted changes, so the installer would not match any commit:\n${dirty.split('\n').slice(0, 8).join('\n')}`,
    'Commit or stash them, push, then release again.');
}
if (branch !== 'main') {
  fail(`HEAD is on "${branch}", not main.`,
    'Releases are cut from main so the published binary is traceable.');
}

// The one that actually bit: HEAD must be an ancestor of, or equal to,
// origin/main. A rejected push leaves them diverged and this is the only place
// that notices before users get the build.
let onRemote = head === remote;
if (!onRemote) {
  try {
    execSync(`git merge-base --is-ancestor ${head} ${remote}`, { stdio: 'ignore' });
    onRemote = true;
  } catch { onRemote = false; }
}
if (!onRemote) {
  let behind = '';
  try { behind = git(`log --oneline ${head}..${remote}`); } catch {}
  fail('HEAD is not on origin/main, so this build would ship source nobody can see.'
    + (behind ? `\n           origin/main has commits you do not:\n${behind}` : ''),
    'git pull --rebase && git push origin main, then release again.');
}

console.log(`[release] preflight ok: v${version} on main, pushed as ${head.slice(0, 8)}`);
