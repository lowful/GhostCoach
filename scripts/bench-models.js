'use strict';

/**
 * HUD-reading bake-off: put candidate vision models in front of REAL frames.
 *
 * Choosing the vision model is the most consequential decision in this product
 * and a spec sheet cannot make it. Two switches proved that. Gemini 3 Flash was
 * picked because it benchmarks ahead on vision, and in this test it read the HUD
 * WORSE than the cheap model while timing out on a third of frames. Qwen3.7
 * Flash was picked on price and returned literally nothing until the reasoning
 * bug was fixed. Neither outcome was predictable from a model card.
 *
 * The AI decision log is the asset that makes this measurable: every coached
 * frame is stored as a jpg next to log.json, which holds the STATE the model of
 * the day parsed from it. So candidates can be run over identical pixels and
 * scored against a session whose map was confirmed at the time.
 *
 * WHAT IS SCORED, and why it is not "does the tip sound good":
 *   valid-label  the printed location the model reports must be a callout that
 *                really exists on the true map. This is the most important
 *                number here, because the client fingerprints the map from these
 *                labels and the callout gate depends on the result. A model that
 *                invents locations disarms both.
 *   lock         whether those labels actually resolve to the right map.
 *   map-right    the model's OWN map guess. Deliberately reported but NOT
 *                ranked on: every model gets this wrong often, which is the
 *                entire reason the label fingerprint exists.
 *   hp/clock     small on-screen numbers, the first thing to degrade.
 *   STATE        did the machine-readable line come back at all. Zero here means
 *                the feedback loop is dead however good the prose looks.
 *   med-ms       a live tip has to land inside the analyze timeout. Two strong
 *                readers were disqualified by this alone.
 *
 * COSTS REAL MONEY. Every call bills the OpenRouter account, and a wide sweep
 * can drain a balance (it has). Start with few frames and few models.
 *
 * Requires: a session in the AI log, a license key in the app config, and the
 * candidate present in BENCH_MODELS in server/routes/coach.js.
 *
 *   node scripts/bench-models.js --map bind --frames 6 qwen/qwen3.7-flash openai/gpt-4.1-mini
 */
const fs = require('fs');
const path = require('path');

const SERVER = process.env.GHOSTCOACH_SERVER || 'https://ghostcoach-production.up.railway.app';
const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
const ROOT = path.join(APPDATA, 'GhostCoach 2.0');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const TRUE_MAP = String(flag('map', 'bind')).toLowerCase();
const FRAME_COUNT = Number(flag('frames', 6));
let SESSION = flag('session', null);
const MODELS = args.filter((a) => a.includes('/'));

if (!MODELS.length) {
  console.log('name at least one model, for example: qwen/qwen3.7-flash');
  process.exit(1);
}

const logDir = path.join(ROOT, 'ai-log');
if (!SESSION) {
  // Newest session that actually has frames.
  const dirs = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((d) => d.startsWith('session-')).sort().reverse() : [];
  SESSION = dirs.find((d) => fs.existsSync(path.join(logDir, d, 'log.json'))
    && fs.readdirSync(path.join(logDir, d)).some((f) => f.endsWith('.jpg')));
}
if (!SESSION) { console.log(`no usable session in ${logDir}`); process.exit(1); }

const dir = path.join(logDir, SESSION);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ghostcoach-config.json'), 'utf8'));
const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
const { __test } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));
const geo = require(path.join(__dirname, '..', 'src', 'shared', 'valorant-data.generated.json')).mapGeometry || {};

// Callouts that genuinely exist on the true map.
const CALLOUTS = new Set();
for (const c of (geo[TRUE_MAP] || {}).callouts || []) {
  CALLOUTS.add(c.n.toLowerCase());
  if (c.a) CALLOUTS.add(String(c.a).toLowerCase());
}
if (!CALLOUTS.size) { console.log(`unknown map "${TRUE_MAP}"`); process.exit(1); }
const norm = (l) => String(l || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
const validLabel = (l) => {
  const n = norm(l);
  return CALLOUTS.has(n) || ['a', 'b', 'c'].some((p) => CALLOUTS.has(`${p} ${n}`));
};

const recs = log.records.filter((r) => r.frame && fs.existsSync(path.join(dir, r.frame)));
const step = Math.max(1, Math.floor(recs.length / FRAME_COUNT));
const sample = [];
for (let i = 0; i < recs.length && sample.length < FRAME_COUNT; i += step) sample.push(recs[i]);

async function run(model) {
  const r = { model, tips: 0, states: 0, mapRight: 0, mapSeen: 0, labelOk: 0, labelSeen: 0,
    hp: 0, clock: 0, errs: 0, ms: [], labels: [], firstErr: null };
  let ctx = {};
  for (const rec of sample) {
    const image = fs.readFileSync(path.join(dir, rec.frame)).toString('base64');
    const t0 = Date.now();
    try {
      const resp = await fetch(`${SERVER}/api/coach/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-license-key': cfg.licenseKey },
        body: JSON.stringify({ image, context: ctx, benchModel: model }),
      });
      if (!resp.ok) {
        r.errs++;
        // Surfaced, never counted as a bad read: a 402 looks exactly like a
        // model that cannot see, and mistaking one for the other produced a
        // confident and completely false result once already.
        if (!r.firstErr) r.firstErr = `${resp.status} ${(await resp.text()).slice(0, 90)}`;
        continue;
      }
      const j = await resp.json();
      r.ms.push(Date.now() - t0);
      const s = j.context || {};
      if (String(j.tip || '').trim()) r.tips++;
      if (Object.keys(s).length) r.states++;
      if (s.map) { r.mapSeen++; if (String(s.map).toLowerCase() === TRUE_MAP) r.mapRight++; }
      if (s.locLabel) { r.labelSeen++; r.labels.push(s.locLabel); if (validLabel(s.locLabel)) r.labelOk++; }
      if (typeof s.playerHp === 'number') r.hp++;
      if (s.clock) r.clock++;
      ctx = { ...ctx, ...s };
    } catch (e) {
      r.errs++;
      if (!r.firstErr) r.firstErr = e.message;
    }
  }
  const lock = __test.mapFromLabels(r.labels);
  r.lock = lock && lock.confident ? lock.map : null;
  return r;
}

(async () => {
  console.log(`${sample.length} frames from ${SESSION}, confirmed ${TRUE_MAP.toUpperCase()}\n`);
  const out = [];
  for (const m of MODELS) {
    process.stdout.write(`  ${m} ... `);
    const r = await run(m);
    out.push(r);
    console.log(r.errs === sample.length ? `ALL FAILED: ${r.firstErr}` : 'done');
  }

  const n = sample.length;
  console.log(`\n${'model'.padEnd(40)} tip   STATE  valid-label  map-guess  hp    lock         med-ms`);
  console.log('-'.repeat(112));
  for (const r of out.sort((a, b) => (b.labelOk - a.labelOk) || (b.states - a.states))) {
    const ms = r.ms.slice().sort((a, b) => a - b);
    const med = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
    const lock = r.lock ? (r.lock.toLowerCase() === TRUE_MAP ? `${r.lock} ok` : `${r.lock} WRONG`) : 'never';
    console.log(
      `${r.model.padEnd(40)} ${String(r.tips).padStart(2)}/${n}  ${String(r.states).padStart(2)}/${n}  ` +
      `${String(r.labelOk).padStart(3)}/${String(r.labelSeen).padEnd(2)}      ` +
      `${String(r.mapRight).padStart(2)}/${String(r.mapSeen).padEnd(2)}     ` +
      `${String(r.hp).padStart(2)}/${n}  ${lock.padEnd(12)} ${String(med).padStart(5)}` +
      (r.errs ? `   ${r.errs} err (${r.firstErr})` : ''));
  }
  console.log(`\nvalid-label is the number that matters: a printed location that really exists on ${TRUE_MAP}.`);
  console.log('map-guess is shown but not ranked on, the client overrides it from the labels.');
  console.log('Any "err" line must be read before trusting a low score: out of credits reads like blindness.');
})();
