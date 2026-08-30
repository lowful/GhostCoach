'use strict';

/**
 * Replace the public download on the MAIN repo with the installer just built.
 *
 * electron-builder publishes to lowful/GhostCoach-releases, which is what
 * electron-updater reads. It does NOT touch lowful/Occlara, whose single
 * release carries the file the website and the README link to. That asset used
 * to be swapped by hand after every release, so it silently drifted a version
 * behind. This runs as the second half of `npm run release`.
 *
 * The asset name must stay EXACTLY `GhostCoach.2.0.Setup.exe`. Every existing
 * download link points at it, and GitHub bakes the name into the URL, so
 * renaming it breaks them all. Note the releases repo uses hyphens for the same
 * file: the two names differ on purpose, do not "fix" one to match the other.
 *
 * Ordering is deliberately paranoid. The old asset is renamed rather than
 * deleted, so a failed upload leaves the previous installer recoverable instead
 * of leaving the download link pointing at nothing.
 */

const fs = require('fs');
const path = require('path');

const OWNER = 'lowful';
// The main repo, renamed from GhostCoach to Occlara on 2026-08-30. GitHub
// redirects the old name, so this kept working, but the redirect is a courtesy
// and not something to depend on. The RELEASE ID below is stable across the
// rename, which is why the download link survived it.
const REPO = 'Occlara';
// The "GhostCoach v2" release. Overridable so the upload path can be exercised
// against a throwaway draft release instead of the live download link.
const RELEASE_ID = process.env.GHOST_DOWNLOAD_RELEASE_ID || 296500148;
const ASSET_NAME = 'GhostCoach.2.0.Setup.exe';
const BACKUP_NAME = 'GhostCoach.2.0.Setup.replacing.exe';

// The rebrand name, published ALONGSIDE the old one and never instead of it.
// Every download link that exists today points at GhostCoach.2.0.Setup.exe and
// GitHub bakes the filename into the URL, so removing it breaks all of them
// with no redirect. New links (the site, the README) use this name, and a
// first-time visitor gets a file called Occlara rather than one named after a
// product they have never heard of. Both are the same bytes from the same
// build, kept in step because this script writes both every release.
const NEW_ASSET_NAME = 'Occlara-Setup.exe';
const NEW_BACKUP_NAME = 'Occlara-Setup.replacing.exe';

const DIST = path.join(__dirname, '..', 'dist');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const api = (p) => `https://api.github.com${p}`;
function headers(extra) {
  return Object.assign({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ghostcoach-release',
  }, extra || {});
}

async function gh(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

/** version, size and sha512 of the installer electron-builder just wrote. */
function readBuildManifest() {
  const file = path.join(DIST, 'latest.yml');
  if (!fs.existsSync(file)) throw new Error('dist/latest.yml not found, run the build first');
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(version|size|sha512):\s*'?([^'\r\n]+)'?\s*$/);
    if (m && out[m[1]] == null) out[m[1]] = m[2].trim();
  }
  if (!out.version || !out.size) throw new Error('could not read version/size from dist/latest.yml');
  out.size = Number(out.size);
  return out;
}

/**
 * The installer is found by SIZE, not by filename. The local artifact keeps
 * spaces ("Occlara Setup.exe") while the published one uses hyphens, the
 * naming has changed across versions, and stale installers from older builds
 * sit in dist/ too. The size from latest.yml describes the file that was just
 * built, so it identifies the right one without depending on any of that.
 */
function findInstaller(manifest) {
  const candidates = fs.readdirSync(DIST)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => ({ f, p: path.join(DIST, f) }))
    .filter(({ p }) => fs.statSync(p).size === manifest.size);

  if (!candidates.length) {
    throw new Error(`no .exe in dist/ matches the built size (${manifest.size} bytes)`);
  }
  if (candidates.length > 1) {
    // Same size twice is not something to guess at.
    throw new Error(`ambiguous installer, ${candidates.length} files match that size: ${candidates.map((c) => c.f).join(', ')}`);
  }
  return candidates[0].p;
}

/**
 * Replace one named asset on the release with the bytes just built.
 *
 * Runs once per published name. The ordering is deliberately paranoid and is
 * unchanged from when this handled a single asset: step the old one aside
 * rather than delete it, upload, verify the byte count, and only then drop the
 * backup. A failed upload therefore leaves the previous installer recoverable
 * instead of leaving a download link pointing at nothing.
 */
async function swapAsset({ assetName, backupName, body, manifest, assets }) {
  const existing = assets.find((a) => a.name === assetName);
  // A leftover backup from a previous failed run would block the rename.
  const staleBackup = assets.find((a) => a.name === backupName);
  if (staleBackup) {
    console.log(`[download] ${assetName}: removing a leftover backup from an earlier run`);
    await gh(api(`/repos/${OWNER}/${REPO}/releases/assets/${staleBackup.id}`), { method: 'DELETE', headers: headers() });
  }

  if (existing && existing.size === manifest.size) {
    console.log(`[download] ${assetName} already matches this build, nothing to do`);
    return;
  }

  // Step back rather than delete: if the upload fails the old installer is
  // still there under BACKUP_NAME and can be renamed back.
  if (existing) {
    const r = await gh(api(`/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`), {
      method: 'PATCH', headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: backupName }),
    });
    if (!r.ok) throw new Error(`could not step ${assetName} aside: HTTP ${r.status} ${r.json && r.json.message}`);
  }

  const up = await gh(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(assetName)}`,
    { method: 'POST', headers: headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) }), body },
  );

  if (!up.ok) {
    if (existing) {
      console.error(`[download] ${assetName}: upload failed, restoring the previous installer`);
      await gh(api(`/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`), {
        method: 'PATCH', headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: assetName }),
      });
    }
    throw new Error(`upload of ${assetName} failed: HTTP ${up.status} ${up.json && up.json.message}`);
  }

  if (up.json.size !== manifest.size) {
    throw new Error(`uploaded ${up.json.size} bytes for ${assetName} but the build is ${manifest.size}`);
  }

  if (existing) {
    await gh(api(`/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`), { method: 'DELETE', headers: headers() });
  }
  console.log(`[download] ${assetName} now serves v${manifest.version} (${up.json.size} bytes)`);
}

async function main() {
  if (!token) {
    console.log('[download] no GH_TOKEN set, skipping the main-repo download swap');
    return;
  }

  const manifest = readBuildManifest();
  const installer = findInstaller(manifest);
  console.log(`[download] publishing ${path.basename(installer)} (${manifest.size} bytes, v${manifest.version})`);

  const rel = await gh(api(`/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}`), { headers: headers() });
  if (!rel.ok) throw new Error(`could not read the release: HTTP ${rel.status} ${rel.json && rel.json.message}`);

  const assets = rel.json.assets || [];
  // Read the installer once; it is ~100MB and both names get the same bytes.
  const body = fs.readFileSync(installer);

  for (const [assetName, backupName] of [[ASSET_NAME, BACKUP_NAME], [NEW_ASSET_NAME, NEW_BACKUP_NAME]]) {
    await swapAsset({ assetName, backupName, body, manifest, assets });
  }
}

main().catch((e) => {
  // A failure here must not read as a failed release: the update itself has
  // already shipped, only the manual download link is behind.
  console.error(`[download] FAILED: ${e.message}`);
  console.error('[download] the release itself published fine; auto-update is unaffected.');
  process.exit(1);
});
