'use strict';

/**
 * Switching the game must switch the stats.
 *
 * THE BUG THIS EXISTS FOR. The stats dashboard had no concept of which game it
 * was for. Every field it returns is Valorant shaped: a Valorant rank ladder,
 * agent tiles, and a competitive/unrated split only Valorant has. Selecting
 * League returned all of it unchanged, so a League player was shown a Valorant
 * rank and a Valorant agent list with nothing saying anything was wrong.
 *
 * The stats window also never learned about the switch at all. Its preload does
 * expose onState, but the renderer only diffed riotId out of it, so a game
 * change pushed state and the dashboard ignored it.
 *
 * Both halves are only observable in a running app with two windows, which is
 * why this boots the real thing rather than reading code. Same reason
 * check-learn-role.js and check-splash-timing.js exist.
 *
 * Results travel through a FILE, not stdout: an Electron main process on Windows
 * does not reliably flush a piped stdout.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'occlara-gameswitch-check.json');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require('electron');
  try { fs.unlinkSync(OUT); } catch { /* nothing to clear */ }

  const env = Object.assign({}, process.env, { OCCLARA_SWITCH_OUT: OUT });
  // This shell exports ELECTRON_RUN_AS_NODE=1, which makes the Electron binary
  // run as plain node and the app dies with a misleading error.
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [__filename], { env, timeout: 120000 });

  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* reported below */ }
  if (!rec) { console.error('FAIL: the check wrote no result (exit ' + r.status + ')'); process.exit(1); }

  for (const line of rec.lines) console.log('  ' + line);
  if (!rec.ok) { console.error('FAIL: ' + rec.detail); process.exit(1); }
  console.log('PASS: switching the game switches the stats, and never shows one game the numbers of another');
  process.exit(0);
}

// Child.
const { app, ipcMain, BrowserWindow } = require('electron');
const C = require(path.join(REPO, 'src/shared/channels'));

const lines = [];
let reported = false;
function report(ok, detail) {
  if (reported) return;
  reported = true;
  try { fs.writeFileSync(process.env.OCCLARA_SWITCH_OUT || OUT, JSON.stringify({ ok, detail, lines })); }
  catch { /* exit code still carries it */ }
  app.exit(ok ? 0 : 1);
}

// A throwaway profile so this never touches a real install.
const ud = path.join(os.tmpdir(), 'occlara-check-gameswitch');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, 'occlara-config.json'), JSON.stringify({
  game: 'valorant', onboardingCompleted: true, licenseKey: '', language: 'en',
}, null, 2));
process.env.OCCLARA_DEV_USERDATA = ud;

app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* the run below decides when we exit */ });

setTimeout(async () => {
  const dash = () => ipcMain._invokeHandlers.get(C.STATS_DASHBOARD)({}, 'competitive', false);
  const setCfg = (partial) => ipcMain._invokeHandlers.get(C.CONFIG_SET)({}, partial);

  try {
    // 1. Valorant: the dashboard must be the real one.
    const before = await dash();
    lines.push('valorant  statsSupported=' + before.statsSupported + '  game=' + before.game);
    if (before.statsSupported !== true) return report(false, 'Valorant reported statsSupported ' + before.statsSupported);
    if (before.game !== 'valorant') return report(false, 'Valorant dashboard carried game=' + before.game);

    // 2. Open stats and confirm it is showing the dashboard, not the blank.
    ipcMain.emit(C.OPEN_STATS, { sender: null });
    await new Promise((r) => setTimeout(r, 2600));
    const win = BrowserWindow.getAllWindows().find((w) => (w.webContents.getURL() || '').indexOf('/stats/') !== -1);
    if (!win) return report(false, 'the stats window never opened');
    const js = (s) => win.webContents.executeJavaScript(s);

    // 3. Watch for the edge triggered push.
    let gotPush = null;
    await js("window.__sawGame = null; window.occlara.onGame((g) => { window.__sawGame = g; }); true");

    const vis = () => js("JSON.stringify({over: !document.getElementById('sec-overview').hidden,"
      + " nostats: !document.getElementById('nostats').hidden})");
    const v1 = JSON.parse(await vis());
    lines.push('valorant  overview=' + v1.over + ' nostats=' + v1.nostats);
    if (!v1.over || v1.nostats) return report(false, 'Valorant should show the dashboard, not the blank panel');

    // 4. Switch to League.
    await setCfg({ game: 'lol' });
    await new Promise((r) => setTimeout(r, 2600));

    gotPush = await js("window.__sawGame ? JSON.stringify(window.__sawGame) : ''");
    lines.push('switch    PUSH_GAME=' + (gotPush || 'NEVER ARRIVED'));
    if (!gotPush) return report(false, 'the stats window was never told the game changed');

    const after = await dash();
    lines.push('lol       statsSupported=' + after.statsSupported + '  game=' + after.game
      + '  topAgents=' + (after.topAgents || []).length + '  mode=' + after.mode);
    if (after.statsSupported !== false) return report(false, 'League reported statsSupported ' + after.statsSupported);
    if ((after.topAgents || []).length) return report(false, 'League returned Valorant agents');
    if (after.mode) return report(false, 'League returned a Valorant queue mode: ' + after.mode);

    const v2 = JSON.parse(await vis());
    lines.push('lol       overview=' + v2.over + ' nostats=' + v2.nostats);
    if (v2.over || !v2.nostats) return report(false, 'League should show the blank panel, not the Valorant dashboard');

    const said = await js("document.getElementById('nostats-body').textContent");
    if (!said || said.indexOf('League of Legends') === -1) {
      return report(false, 'the blank panel does not name the game: ' + said);
    }
    lines.push('lol       says: ' + said.slice(0, 60) + '...');

    // 5. Switch back. The dashboard must come back, not stay blank.
    await setCfg({ game: 'valorant' });
    await new Promise((r) => setTimeout(r, 2600));
    const v3 = JSON.parse(await vis());
    lines.push('back      overview=' + v3.over + ' nostats=' + v3.nostats);
    if (!v3.over || v3.nostats) return report(false, 'switching back to Valorant left the blank panel up');

    report(true, 'ok');
  } catch (e) {
    report(false, 'threw: ' + e.message);
  }
}, 7000);

require(path.join(REPO, 'src/main/index.js'));
