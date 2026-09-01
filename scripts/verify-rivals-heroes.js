'use strict';

/**
 * Grade the Rivals HERO READ against real capture frames.
 *
 * This measures the one thing that decides whether live Rivals tips can ship.
 * Everything downstream (the switch call, the moment gate, the glyphs) is
 * offline-testable and already passing. None of it is worth anything if the
 * coach cannot tell who is on screen, and until now that read had never been
 * measured: a wrong hero surfaced only as a slightly odd sentence, which is
 * unfalsifiable.
 *
 * `/api/rivals/identify` exists so the read can be asked for on its own, with
 * no coaching attached, and compared against what a human says is in the frame.
 *
 * SETUP
 *   1. Put frames in fixtures/rivals/ (gitignored: they are pictures of
 *      someone's screen and this repo is public).
 *   2. Write fixtures/rivals/heroes-truth.json:
 *        { "scoreboard-1.jpg": { "mine": "Iron Man",
 *                                "enemy": ["The Punisher", "Groot"],
 *                                "ally":  ["Luna Snow"] } }
 *      Only list heroes YOU can see in the frame. A hero you left out counts
 *      against precision if the model reports it, which is the point.
 *   3. OCCLARA_LICENSE=<key> node scripts/verify-rivals-heroes.js
 *
 * WHAT THE NUMBERS MEAN
 *   recall     of the heroes really there, how many were found. Low recall
 *              costs coverage: fewer tips, none of them wrong.
 *   precision  of the heroes reported, how many were really there. Low
 *              precision is the dangerous one, because a hallucinated enemy
 *              hero is what produces a confident, wrong switch call.
 *   side       of the heroes correctly named, how many were put on the right
 *              team. "Switch, they have two hitscan" is wrong if the two
 *              hitscan are your own team.
 *
 * PRECISION IS THE GATE. Recall can be poor and the feature still ships,
 * because rivals-heroes.js already treats an unknown hero as silence. Precision
 * cannot: there is no downstream guard that catches a hero who was never there.
 */

const fs = require('fs');
const path = require('path');
const heroes = require('../server/services/rivals-heroes');
const { profileDir } = require('./profile-path');

const SERVER = process.env.OCCLARA_SERVER || 'https://ghostcoach-production.up.railway.app';
const DIR = path.join(__dirname, '..', 'fixtures', 'rivals');
const TRUTH = path.join(DIR, 'heroes-truth.json');

// Thresholds. Precision is the one that blocks.
const MIN_PRECISION = 0.90;
const MIN_SIDE = 0.85;

function licenceKey() {
  if (process.env.OCCLARA_LICENSE) return process.env.OCCLARA_LICENSE.trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(profileDir(), 'occlara-config.json'), 'utf8'));
    return (cfg.licenseKey || cfg.license || '').trim();
  } catch { return ''; }
}

const norm = (n) => heroes.normalise(n);
/** Compare on the canonical name so an alias is not counted as a miss. */
const canon = (n) => {
  const t = heroes.traits(n);
  return t ? t.name : norm(n);
};

async function main() {
  if (!fs.existsSync(TRUTH)) {
    console.log('No fixtures/rivals/heroes-truth.json yet.');
    console.log('Add frames to fixtures/rivals/ and write that file, then run this again.');
    console.log('See the header of this script for the shape.');
    return;
  }
  const key = licenceKey();
  if (!key) { console.log('No licence key. Set OCCLARA_LICENSE or sign in once.'); return; }

  const truth = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
  const files = Object.keys(truth);
  if (!files.length) { console.log('heroes-truth.json is empty.'); return; }

  console.log(`grading the hero read on ${files.length} frame(s)`);
  console.log(`server: ${SERVER}\n`);

  let tp = 0, fp = 0, fn = 0, sideRight = 0, sideTotal = 0, failed = 0;

  for (const file of files) {
    const full = path.join(DIR, file);
    if (!fs.existsSync(full)) { console.log(`  skip ${file}: not found`); continue; }

    const expect = truth[file] || {};
    const wanted = new Map();
    for (const side of ['mine', 'ally', 'enemy']) {
      const v = expect[side];
      for (const n of (Array.isArray(v) ? v : (v ? [v] : []))) wanted.set(canon(n), side);
    }

    let got = [];
    try {
      const image = fs.readFileSync(full).toString('base64');
      const r = await fetch(`${SERVER}/api/rivals/identify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-License-Key': key },
        body: JSON.stringify({ image }),
      });
      if (!r.ok) { console.log(`  ${file}: HTTP ${r.status}`); failed++; continue; }
      got = (await r.json()).heroes || [];
    } catch (e) { console.log(`  ${file}: ${e.message}`); failed++; continue; }

    const seen = new Map();
    for (const h of got) seen.set(canon(h.name), h.side);

    const hit = [...seen.keys()].filter((n) => wanted.has(n));
    const miss = [...wanted.keys()].filter((n) => !seen.has(n));
    const ghost = [...seen.keys()].filter((n) => !wanted.has(n));

    tp += hit.length; fn += miss.length; fp += ghost.length;
    for (const n of hit) {
      sideTotal++;
      // "unknown" is an honest abstention, not a wrong answer, so it is not
      // counted either way.
      if (seen.get(n) === 'unknown') { sideTotal--; continue; }
      if (seen.get(n) === wanted.get(n)) sideRight++;
    }

    console.log(`  ${file}`);
    console.log(`    found ${hit.length}/${wanted.size}` +
      (miss.length ? `  missed: ${miss.join(', ')}` : '') +
      (ghost.length ? `   INVENTED: ${ghost.join(', ')}` : ''));
  }

  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const sideAcc = sideTotal ? sideRight / sideTotal : 1;

  console.log('\n  ' + 'precision'.padEnd(12) + (precision * 100).toFixed(0) + '%  (min ' + MIN_PRECISION * 100 + '%, the gate)');
  console.log('  ' + 'recall'.padEnd(12) + (recall * 100).toFixed(0) + '%  (no minimum, low recall only costs coverage)');
  console.log('  ' + 'side'.padEnd(12) + (sideAcc * 100).toFixed(0) + '%  (min ' + MIN_SIDE * 100 + '%)');
  if (failed) console.log(`  ${failed} frame(s) failed to reach the server`);

  const ok = precision >= MIN_PRECISION && sideAcc >= MIN_SIDE;
  if (!ok) {
    console.log('\nFAIL: the hero read is not trustworthy enough for live tips.');
    console.log('A hero the coach invented becomes a confident switch call about someone who is not there.');
    process.exit(1);
  }
  console.log('\nPASS: the hero read is good enough to build live tips on.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
