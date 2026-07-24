#!/usr/bin/env node
'use strict';

/**
 * Sync the current Valorant patch into GhostCoach so the coach never advises
 * around a change that already happened (a nerfed ability, a reworked gun).
 *
 * Two authoritative sources, no interpretation in between:
 *   - valorant-api.com/v1/version  -> which patch is actually live
 *   - Riot's own patch notes page  -> the change lines, kept VERBATIM
 *
 * Lines are never summarised or paraphrased here. Riot's wording goes straight
 * to the coach, which is what keeps this trustworthy: a summarising step is a
 * place for facts to get bent, and coaching built on a bent fact is worse than
 * coaching with no patch knowledge at all.
 *
 * Run:  npm run sync:patch
 * Writes server/patch-notes.generated.json (server only; the client never needs it).
 */

const fs = require('fs');
const path = require('path');

const VERSION_URL = 'https://valorant-api.com/v1/version';
const WEAPONS_URL = 'https://valorant-api.com/v1/weapons';
const AGENTS_URL  = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const NOTES_INDEX = 'https://playvalorant.com/en-us/news/game-updates/';
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; GhostCoach patch sync)' };

// A line has to actually say something to be worth shipping; bare headings
// ("Iso", "Gatecrash") carry no information for the coach.
const MIN_WORDS = 5;
const MAX_LINE  = 240;
const MAX_LINES = 40;

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !j.data) throw new Error(`${url} -> no data`);
  return j.data;
}

/**
 * Readable text out of a Riot news page, with list items kept as lines.
 *
 * The page ends with a carousel of OTHER patches' articles, and their teaser
 * text reads exactly like a change line ("Neon and shotgun nerfs are here!").
 * Pulling those in would attribute another patch's changes to this one, so the
 * page is cut at the first recommendation card before any text is read.
 */
function htmlToLines(rawHtml) {
  const cut  = rawHtml.search(/data-testid="card-title"/i);
  const html = cut > 1000 ? rawHtml.slice(0, cut) : rawHtml;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#x27;|&rsquo;|&#39;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&hellip;/g, '...')
    .replace(/[ \t]+/g, ' ');
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** "release-13.01" -> "13.01" */
function patchFromBranch(branch) {
  const m = String(branch || '').match(/(\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * The patch notes URL for a version. Riot's slug is stable
 * ("valorant-patch-notes-13-01"), but we confirm against the index rather than
 * trusting the guess, so a naming change degrades to "notes unavailable"
 * instead of silently shipping the wrong patch's changes.
 */
async function findNotesUrl(patch) {
  const slug = patch.replace('.', '-');
  const guess = `${NOTES_INDEX}valorant-patch-notes-${slug}/`;
  try {
    const r = await fetch(guess, { headers: UA });
    if (r.ok) return guess;
  } catch {}
  // Fall back to whatever the index actually links for this patch.
  try {
    const html = await (await fetch(NOTES_INDEX, { headers: UA })).text();
    const re = new RegExp(`href="([^"]*valorant-patch-notes-${slug}[^"]*)"`, 'i');
    const m = html.match(re);
    if (m) return m[1].startsWith('http') ? m[1] : `https://playvalorant.com${m[1]}`;
  } catch {}
  return null;
}

function classify(line, agents, weapons, maps) {
  const hits = [];
  for (const [type, names] of [['agent', agents], ['weapon', weapons], ['map', maps]]) {
    for (const n of names) {
      // Word-boundary match so "Sage" never fires inside another word.
      if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`, 'i').test(line)) {
        hits.push({ type, name: n });
      }
    }
  }
  return hits;
}

async function main() {
  console.log('Checking the live Valorant patch ...');
  const [version, weaponRows, agentRows] = await Promise.all([
    getJson(VERSION_URL), getJson(WEAPONS_URL), getJson(AGENTS_URL),
  ]);

  const patch = patchFromBranch(version.branch);
  if (!patch) throw new Error(`could not read a patch number from branch "${version.branch}"`);

  const agents  = agentRows.map((a) => a.displayName).filter(Boolean);
  const weapons = weaponRows.map((w) => w.displayName).filter((n) => n && n !== 'Melee');
  let maps = [];
  try {
    maps = Object.keys(require('../server/valorant-data.generated.json').mapGeometry || {})
      .map((m) => m[0].toUpperCase() + m.slice(1));
  } catch {}

  const outPath = path.join(__dirname, '..', 'server', 'patch-notes.generated.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}

  console.log(`Live patch: ${patch} (built ${version.buildDate})`);
  const url = await findNotesUrl(patch);

  const data = {
    generatedAt: new Date().toISOString(),
    patch,
    buildDate: version.buildDate || null,
    source: url,
    headline: null,
    changes: [],       // [{ type, name, line }] verbatim from Riot
    notesFound: false,
  };

  if (!url) {
    console.warn(`No patch notes page found for ${patch}. Shipping the version only;`);
    console.warn('the coach will know which patch is live but not what changed.');
  } else {
    const html  = await (await fetch(url, { headers: UA })).text();
    const lines = htmlToLines(html);

    // Riot's own one-line summary sits in the page description.
    const desc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]{20,300})"/i)
              || html.match(/"description"\s*:\s*"([^"]{20,300})"/);
    if (desc) data.headline = desc[1].trim();

    const seen = new Set();
    // The headline already leads the block; repeating it as a change line just
    // spends prompt space saying the same thing twice.
    if (data.headline) seen.add(data.headline.toLowerCase());
    for (const line of lines) {
      if (line.length > MAX_LINE || line.split(/\s+/).length < MIN_WORDS) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      const hits = classify(line, agents, weapons, maps);
      if (!hits.length) continue;
      seen.add(key);
      // One entry per line, tagged with everything it mentions.
      data.changes.push({
        type: hits[0].type,
        names: [...new Set(hits.map((h) => h.name))],
        line,
      });
      if (data.changes.length >= MAX_LINES) break;
    }
    data.notesFound = data.changes.length > 0;
  }

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');

  console.log(`\nPatch ${patch}${data.headline ? ': ' + data.headline : ''}`);
  console.log(`Change lines captured: ${data.changes.length}`);
  for (const c of data.changes.slice(0, 8)) {
    console.log(`  [${c.type}] ${c.names.join(', ')}: ${c.line.slice(0, 90)}`);
  }
  if (prev.patch && prev.patch !== patch) {
    console.log(`\nNEW PATCH: ${prev.patch} -> ${patch}`);
  } else if (prev.patch === patch) {
    console.log('\nSame patch as the last sync.');
  }
  console.log(`\nWrote: ${outPath}`);
}

main().catch((e) => { console.error('patch sync failed:', e.message); process.exit(1); });
