'use strict';

/**
 * The Learn surface must show a player only the skills their role has.
 *
 * WHY THIS RUNS A REAL APP. getLearn() filters `skills` by role correctly, and
 * the renderer ignored it anyway: a support was shown the CS lesson and a
 * denominator of twelve, so "12 of 12" was unreachable for them and the one
 * lesson they could never finish was the one that would cost them games if they
 * followed it. Chasing CS as a support takes the farm off the ADC.
 *
 * Nothing in the node-only test set could see that. The payload was right, the
 * DOM was wrong, and the two only meet in a running window. Same reason
 * shot-surface.js exists.
 *
 * Role comes from OCCLARA_CHECK_ROLE so one script covers both cases; the npm
 * script runs it once per role.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');

/*
 * Run under plain node and this is the PARENT: it spawns itself under Electron
 * once per role. Run under Electron and it is the child that does the work.
 * One file, and `node scripts/...` like every other check in this repo.
 */
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require('electron');            // resolves to the binary path
  const CASES = [
    { role: 'Mid', count: 12, cs: '1' },
    { role: 'Support', count: 11, cs: '0' },       // no CS lesson: it costs the ADC farm
  ];
  let bad = 0;
  for (const c of CASES) {
    const env = Object.assign({}, process.env, {
      OCCLARA_CHECK_ROLE: c.role,
      OCCLARA_CHECK_COUNT: String(c.count),
      OCCLARA_CHECK_CS: c.cs,
    });
    // This shell exports ELECTRON_RUN_AS_NODE=1, which makes the Electron
    // binary behave as plain node and the app dies with a misleading error.
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [__filename], { env, stdio: 'inherit', timeout: 120000 });
    if (r.status !== 0) bad += 1;
  }
  if (bad) { console.error('FAIL: ' + bad + ' of ' + CASES.length + ' roles wrong'); process.exit(1); }
  console.log('PASS: the Learn surface shows each role only its own skills');
  process.exit(0);
}

const { app, ipcMain, BrowserWindow } = require('electron');
const C = require(path.join(REPO, 'src/shared/channels'));

const ROLE = process.env.OCCLARA_CHECK_ROLE || 'Mid';
const EXPECT = Number(process.env.OCCLARA_CHECK_COUNT || 12);
const CS_SHOWN = process.env.OCCLARA_CHECK_CS !== '0';

const fail = (m) => { console.error('FAIL [' + ROLE + '] ' + m); app.exit(1); };

setTimeout(async () => {
  let data;
  try { data = await ipcMain._invokeHandlers.get(C.LEARN_GET)({}, {}); }
  catch (e) { return fail('LEARN_GET threw: ' + e.message); }
  if (!data) return fail('LEARN_GET returned nothing');

  if (data.role !== ROLE) return fail('store role is ' + data.role + ', expected ' + ROLE);
  if (data.skills.length !== EXPECT) {
    return fail('payload has ' + data.skills.length + ' skills, expected ' + EXPECT);
  }
  // The assignment must never be a skill this role does not have.
  const ids = new Set(data.skills.map((s) => s.lesson || s.id));
  if (data.assignment && !ids.has(data.assignment.skillId)) {
    return fail('assigned ' + data.assignment.skillId + ', which this role does not have');
  }

  ipcMain.emit(C.OPEN_LEARN, { sender: null });
  setTimeout(async () => {
    const w = BrowserWindow.getAllWindows().find((x) => (x.getTitle() || '').indexOf('Learn') !== -1);
    if (!w) return fail('the Learn window never opened');
    const errs = [];
    w.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2) errs.push(msg); });
    setTimeout(async () => {
      const js = (src) => w.webContents.executeJavaScript(src);
      try {
        const prog = await js("document.getElementById('prog-text').textContent");
        const browse = await js("document.getElementById('a-browse').textContent");
        await js("document.getElementById('a-browse').click()");
        const rows = await js("document.querySelectorAll('#tracks .lesson-row').length");
        const cs = await js("document.getElementById('tracks').textContent.indexOf('minions, not kills') !== -1");

        if (rows !== EXPECT) return fail('list drew ' + rows + ' rows, expected ' + EXPECT);
        if (prog.indexOf('of ' + EXPECT) === -1) return fail('progress reads "' + prog + '", expected "of ' + EXPECT + '"');
        if (cs !== CS_SHOWN) return fail('CS lesson shown=' + cs + ', expected ' + CS_SHOWN);
        if (errs.length) return fail('renderer errors: ' + errs.join(' | '));

        console.log('PASS [' + ROLE + '] ' + EXPECT + ' skills, progress "' + prog + '", browse "' + browse + '", CS shown=' + cs);
        app.exit(0);
      } catch (e) { fail('reading the DOM threw: ' + e.message); }
    }, 2200);
  }, 2200);
}, 6500);

// A throwaway profile, so this never touches a real install.
const ud = path.join(os.tmpdir(), 'occlara-check-learn-role');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(
  path.join(ud, 'occlara-config.json'),
  JSON.stringify({ game: 'lol', onboardingCompleted: true, lolRole: ROLE, licenseKey: '', language: 'en' }, null, 2),
);
process.env.OCCLARA_DEV_USERDATA = ud;

require(path.join(REPO, 'src/main/index.js'));
