'use strict';

/**
 * Pull League champion data and icons from Riot's Data Dragon.
 *
 * Mirrors `npm run sync:valorant`: a maintainer runs it, it writes a generated
 * JSON file plus assets, and those are what ship. The app never calls Riot at
 * runtime, so coaching does not sit behind someone else's CDN and the client
 * still renders with no network at all.
 *
 * WHY ICONS ARE BUNDLED HERE AND WERE FORBIDDEN FOR MARVEL RIVALS. That was a
 * trademark constraint on NetEase artwork, not a general rule, and it does not
 * carry over. Riot publishes Data Dragon for third-party use, so League ships
 * real champion portraits. Measured before deciding: 173 icons at roughly 27KB
 * each is about 4.6MB on a 100MB installer, which buys offline rendering and no
 * CSP change (img-src is 'self'). Separately, a PAID product still needs Riot
 * product registration and approval; that is a permission to obtain, not a
 * reason to avoid the data.
 *
 * THE PATCH AND THE COUNT ARE DERIVED, NEVER TYPED. The roster changes every
 * patch, and a hardcoded number is a lie with a date on it.
 *
 *   npm run sync:lol
 */

const fs = require('fs');
const path = require('path');

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const OUT_JSON = path.join(__dirname, '..', 'src', 'shared', 'lol-data.generated.json');
const OUT_ICONS = path.join(__dirname, '..', 'assets', 'lol', 'champions');
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; Occlara LoL sync)' };

// Below this, the response shape has changed and writing it would replace good
// data with rubbish. League has had well over a hundred champions for years.
const SANITY_MIN = 100;

// Melee champions sit at 125 to 175, ranged start around 500. Nothing real sits
// in the gap, so the exact threshold is not delicate.
const RANGED_AT = 300;

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
  return r.json();
}

/** Riot's own difficulty score, 1 to 10, straight off champion.json. */
function difficultyBand(n) {
  if (n <= 3) return 'low';
  if (n <= 7) return 'medium';
  return 'high';
}

async function main() {
  console.log('[lol] resolving the current patch');
  const versions = await getJson(`${DDRAGON}/api/versions.json`);
  const patch = Array.isArray(versions) && versions[0];
  if (!patch) throw new Error('could not read a patch from versions.json');
  console.log(`[lol] patch ${patch}`);

  const champJson = await getJson(`${DDRAGON}/cdn/${patch}/data/en_US/champion.json`);
  const entries = Object.values(champJson.data || {});
  if (entries.length < SANITY_MIN) {
    throw new Error(`only ${entries.length} champions returned, the shape has changed. Nothing written.`);
  }

  const champions = entries
    .map((c) => ({
      id: c.id,                       // 'Ahri', the key Data Dragon and the Live API both use
      key: c.key,                     // numeric id as a string
      name: c.name,                   // 'Ahri', what a player calls it
      title: c.title,
      tags: c.tags || [],             // Riot's own roles: Mage, Assassin, Fighter...
      resource: c.partype || '',      // Mana, Energy, Fury...
      difficulty: (c.info && c.info.difficulty) || null,
      difficultyBand: c.info ? difficultyBand(c.info.difficulty) : null,
      attack: c.info && c.info.attack,
      defense: c.info && c.info.defense,
      magic: c.info && c.info.magic,
      // Melee or ranged is DERIVED from Riot's own attackrange rather than
      // hand authored. 175 is a melee champion, 550 is a ranged one, and the
      // split sits comfortably between them. One less table to rot.
      attackRange: (c.stats && c.stats.attackrange) || null,
      range: c.stats && c.stats.attackrange >= RANGED_AT ? 'ranged' : 'melee',
      icon: `lol/champions/${c.id}.png`,   // relative to assets/
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(OUT_ICONS, { recursive: true });

  // Small batches rather than 173 parallel requests: this is someone else's CDN
  // and there is no hurry.
  let fetched = 0, skipped = 0, failed = 0;
  const BATCH = 8;
  for (let i = 0; i < champions.length; i += BATCH) {
    await Promise.all(champions.slice(i, i + BATCH).map(async (c) => {
      const dest = path.join(OUT_ICONS, `${c.id}.png`);
      try {
        const r = await fetch(`${DDRAGON}/cdn/${patch}/img/champion/${c.id}.png`, { headers: UA });
        if (!r.ok) { failed++; return; }
        const buf = Buffer.from(await r.arrayBuffer());
        // Only write when the bytes actually differ. Riot rarely re-renders an
        // existing icon, so this keeps a patch bump from adding 173 identical
        // blobs to git history every time.
        if (fs.existsSync(dest) && fs.readFileSync(dest).equals(buf)) { skipped++; return; }
        fs.writeFileSync(dest, buf);
        fetched++;
      } catch { failed++; }
    }));
    process.stdout.write(`\r[lol] icons ${Math.min(i + BATCH, champions.length)}/${champions.length}`);
  }
  process.stdout.write('\n');

  const payload = {
    generatedAt: new Date().toISOString(),
    source: `${DDRAGON}/cdn/${patch}/data/en_US/champion.json`,
    patch,
    count: champions.length,       // derived, never typed
    champions,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2) + '\n');

  console.log(`[lol] wrote ${champions.length} champions for patch ${patch}`);
  console.log(`[lol] icons: ${fetched} written, ${skipped} unchanged, ${failed} failed`);
  if (failed) console.log('[lol] a failed icon is not fatal: the surface falls back to the champion name.');
}

main().catch((e) => { console.error(`[lol] sync failed: ${e.message}`); process.exit(1); });
