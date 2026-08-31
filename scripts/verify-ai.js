'use strict';

/**
 * Regression gate for the COACH ITSELF. Run this after any change to the
 * prompt, the model, or the guards, before trusting it in front of players.
 *
 * Everything else in scripts/ tests code. Nothing tested the thing the product
 * actually sells, which is the quality of what the model writes, and that gap
 * has been expensive:
 *
 *   - a model with "flash" in its name reasoned by default and returned ZERO
 *     tips and ZERO STATE lines. Nothing errored. The overlay simply went quiet
 *     and the app looked healthy for an entire session.
 *   - a prompt edit meant to stop repetition shipped straight to production and
 *     was never measured; repetition stayed at 84% of all rejections.
 *   - tips claiming "last alive" with three teammates up reached a player,
 *     because no gate compared what the coach SAID against what it had READ.
 *
 * Every one of those is invisible to unit tests and obvious within ten frames of
 * a real session. So this replays real logged frames through the live server and
 * grades what comes back, against thresholds that fail loudly.
 *
 * It costs real money per run (one vision call per frame) and it needs the
 * server deployed, so it is a deliberate pre-flight rather than something to run
 * in a loop.
 *
 *   npm run verify:ai              10 frames from the newest session
 *   npm run verify:ai -- --frames 20
 */
const fs = require('fs');
const path = require('path');
const { polishText } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'tip-hygiene.js'));
const { __test } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));

const SERVER = process.env.OCCLARA_SERVER || 'https://ghostcoach-production.up.railway.app';
const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
const { profileDir, configPath } = require('./profile-path');
const ROOT = profileDir(APPDATA);

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FRAMES = Number(flag('frames', 10));

// THRESHOLDS. Each is set where the KNOWN failure would have tripped it, not at
// a round number: a model returning nothing scores 0 on the first two, and the
// session that shipped two false claims scored 86.7% on accuracy.
const MIN_TIP_RATE = 60;    // % of frames that produce a tip or a deliberate SKIP
const MIN_STATE_RATE = 90;  // % of frames that return a parseable STATE line
const MIN_GUARD_INPUT = 80; // % of frames carrying locLabel, the field the map lock needs
const MIN_ACCURACY = 95;      // % of SURVIVING tips that break no checkable rule
const MIN_SURVIVOR_RATE = 70; // % of written tips the guards do not have to block

const cfgPath = configPath(ROOT);
if (!fs.existsSync(cfgPath)) { console.log(`No config at ${cfgPath}`); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

// Frames come from the AI decision log, which rotates, so this uses the newest
// session with enough frames rather than a fixed set. Screenshots are not
// committed to the repo on purpose: they are pictures of somebody's screen and
// this repository is public.
const logDir = path.join(ROOT, 'ai-log');
const sessions = fs.existsSync(logDir)
  ? fs.readdirSync(logDir).filter((d) => d.startsWith('session-')).sort().reverse() : [];
const session = sessions.map((d) => path.join(logDir, d)).find((d) => {
  if (!fs.existsSync(path.join(d, 'log.json'))) return false;
  return fs.readdirSync(d).filter((f) => f.endsWith('.jpg')).length >= FRAMES;
});
if (!session) { console.log(`No session with ${FRAMES}+ frames in ${logDir}`); process.exit(0); }

const log = JSON.parse(fs.readFileSync(path.join(session, 'log.json'), 'utf8'));
const recs = log.records.filter((r) => r.frame && fs.existsSync(path.join(session, r.frame)));
const step = Math.max(1, Math.floor(recs.length / FRAMES));
const sample = [];
for (let i = 0; i < recs.length && sample.length < FRAMES; i += step) sample.push(recs[i]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`verifying the coach against ${sample.length} real frames from ${path.basename(session)}`);
  console.log(`server: ${SERVER}\n`);

  let tips = 0, states = 0, guardInput = 0, ok = 0, errs = 0;
  let firstErr = null;
  const blocked = [];
  let ctx = {};
  // Mirrors matchContext.lastDeathAt in the engine, which is what makes a death
  // review legitimate to the alive-claim guard.
  let lastDeathAt = 0;

  for (const r of sample) {
    const image = fs.readFileSync(path.join(session, r.frame)).toString('base64');
    await sleep(1200);            // a burst gets rate limited, and a 429 reads like an empty wallet
    let j;
    try {
      const resp = await fetch(`${SERVER}/api/coach/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-license-key': cfg.licenseKey },
        body: JSON.stringify({ image, context: ctx }),
      });
      if (!resp.ok) {
        errs++;
        if (!firstErr) firstErr = `${resp.status} ${(await resp.text()).slice(0, 90)}`;
        continue;
      }
      j = await resp.json();
    } catch (e) { errs++; if (!firstErr) firstErr = e.message; continue; }

    ok++;
    const s = j.context || {};
    const raw = String(j.tip || '').trim();
    // SKIP and LOBBY are protocol, not coaching: the model saying "this frame is
    // not gameplay" is it working correctly. Grading them as tips scored a
    // healthy run at 75% and would have blocked a good deploy.
    const isProtocol = /^(SKIP|LOBBY)$/i.test(raw);
    const tip = isProtocol ? '' : raw;
    if (tip) tips++;
    if (Object.keys(s).length) states++;
    if (s.locLabel) guardInput++;

    // TWO DIFFERENT NUMBERS, and conflating them hides the interesting one.
    //
    // The model's raw output is not expected to be clean; the guards exist
    // precisely because it is not. What must be clean is what SURVIVES them,
    // because that is what a player reads. So a tip the guards would reject is
    // counted as blocked, not as an error, and accuracy is measured over the
    // survivors. A rising block rate is its own warning: it means the model got
    // worse even though the player never saw it.
    // THE GUARDS MUST BE JUDGED ON THE CONTEXT PRODUCTION GIVES THEM.
    //
    // contradictsState is called in the engine with matchContext, which carries
    // client-side fields the server never returns, and lastDeathAt is the one
    // that matters here: it is what tells the alive-claim guard that a death
    // review is legitimate rather than a claim about a living player.
    //
    // Replaying with the server context alone made this gate reject four real
    // death reviews and report a 44% survivor rate, which would have blocked a
    // good deploy. That is the same failure as a checker keeping its own copy of
    // a rule: the gate has to model what the engine actually does, not a
    // convenient subset of it.
    if (s.playerAlive === false || s.phase === 'dead') lastDeathAt = Date.now();
    const judged = lastDeathAt ? { ...s, lastDeathAt } : s;

    if (tip) {
      const why = __test.contradictsState(tip, judged) ? 'contradicts the counted state'
        : polishText(tip, 'ai') === null ? 'fails the text rules' : null;
      if (why) blocked.push({ why, tip });
    }
    ctx = { ...ctx, ...s };
  }

  if (!ok) {
    console.log(`every request failed: ${firstErr}`);
    console.log('\nFAIL: the coach could not be reached, so nothing was verified.');
    process.exit(1);
  }

  const pct = (n) => Math.round((n / ok) * 100);
  // Accuracy is measured over what SURVIVES the guards, because that is what a
  // player actually reads. Everything the guards caught is reported separately
  // as a block rate: a rising one means the model degraded even though nobody
  // saw it, which is exactly the early warning this gate exists to give.
  const survivors = tips - blocked.length;
  const accuracy = tips === 0 ? 100 : (survivors > 0 ? 100 : 0);
  const blockRate = tips ? Math.round((blocked.length / tips) * 100) : 0;

  const results = [
    ['a tip comes back at all', pct(tips), MIN_TIP_RATE,
      'zero here is the model-returns-nothing outage, which looks like a quiet overlay'],
    ['STATE parses', pct(states), MIN_STATE_RATE,
      'STATE is the feedback loop; without it every later frame is judged blind'],
    ['guard inputs present (locLabel)', pct(guardInput), MIN_GUARD_INPUT,
      'the map lock and the callout gate are built on this field'],
    ['tips surviving the guards', 100 - blockRate, MIN_SURVIVOR_RATE,
      'the model is writing junk the guards must throw away, so the player hears less'],
    ['accuracy of what survives', accuracy, MIN_ACCURACY,
      'what reaches the player must break no checkable rule'],
  ];

  let failed = 0;
  for (const [name, value, min, why] of results) {
    const good = value >= min;
    if (!good) failed++;
    console.log(`${good ? 'ok  ' : 'FAIL'}  ${name.padEnd(32)} ${String(value).padStart(5)}%  (min ${min}%)`);
    if (!good) console.log(`        ${why}`);
  }
  if (errs) console.log(`\n${errs} request(s) failed: ${firstErr}`);
  if (blocked.length) {
    console.log(`\n${blocked.length} tip(s) the guards blocked before any player saw them:`);
    for (const e of blocked.slice(0, 4)) console.log(`  ${e.why}: ${e.tip.slice(0, 90)}`);
  }

  console.log(failed
    ? `\nFAIL: ${failed} measure(s) below threshold. Do not ship this prompt or model.`
    : '\nPASS: the coach still reads the screen and says checkable things.');
  process.exit(failed ? 1 : 0);
})();
