'use strict';

/**
 * Text hygiene for anything an LLM writes for the overlay.
 *
 * Nothing in here knows what game is being played. These are defects of the
 * MODEL, not of Valorant: a reply that shouts, one that drops a noun halfway
 * through a sentence, one that opens with "Sure, here is a tip", one that stops
 * mid-clause because the token budget ran out. A second game will meet every one
 * of them on day one, which is why this is separated rather than copied.
 *
 * Split out of coaching-engine.js unchanged. Every rule below was written
 * because the defect actually reached a player, and the comments say which.
 */

// Model preamble. The tip is the answer, never the announcement of the answer.
const PREAMBLE = [
  /^here is/i, /^here's/i, /^sure[,!]/i, /^okay[,!]/i, /^the json/i,
  /^as requested/i, /^based on/i, /^analyzing/i, /^looking at/i, /^i'll/i, /^i can/i,
];

// A reply cut off mid sentence really does end on one of these. Ordering and
// case matter more than they look: "a" is checked LOWERCASE ONLY, because "A"
// is a site, and matching it case-insensitively threw away perfectly good tips
// that happened to end on the A site.
const TRUNCATION = [
  // dangling connectives / articles / prepositions
  /\band\.?$/i, /\bor\.?$/i, /\bbut\.?$/i, /\bto\.?$/i, /\bwith\.?$/i, /\bfor\.?$/i,
  /\bthe\.?$/i, /\ban\.?$/i, /\bof\.?$/i, /\bin\.?$/i, /\bat\.?$/i,
  // "a" is checked lowercase ONLY, because "A" is a SITE. Case-insensitively
  // this threw away every tip that ended on the A site, which is a completely
  // ordinary way to finish a sentence here: "do not step out alone since your
  // team is grouped on A." was rejected as cut off mid sentence. Three good
  // tips went in the bin in one day over a capital letter.
  /\ba\.?$/,
  /\bon\.?$/i, /\byour\.?$/i, /\bmy\.?$/i, /'s\.?$/i, /,\s*$/,
  // transitive verbs that normally need an object: as the LAST word they mean
  // the model got cut off ("...health, play." / "...so you can take.")
  /\bplay\.?$/i, /\btake\.?$/i, /\buse\.?$/i, /\busing\.?$/i, /\bthrow\.?$/i,
  /\bget\.?$/i, /\bkeep\.?$/i, /\bsave\.?$/i, /\bset\.?$/i, /\bput\.?$/i, /\bgo\.?$/i,
  /\bdeploy\.?$/i, /\bpop\.?$/i, /\bforce\.?$/i, /\bline\.?$/i, /\bpre\.?$/i,
  /\bbait\.?$/i, /\bgrab\.?$/i, /\bhit\.?$/i, /\bavoid\.?$/i, /\bwatch\.?$/i,
];

function countOf(str, ch) {
  let n = 0;
  for (const c of str) if (c === ch) n++;
  return n;
}

/** Dashes are banned in this product's copy, everywhere. */
function cleanTip(tip) {
  return String(tip == null ? '' : tip).replace(/ - /g, ', ').trim();
}

// ── repeat detection primitives ─────────────────────────────────────────────
// Meaningful words only (4+ chars) so overlap measures the advice, not the
// glue words; punctuation is stripped everywhere so "peek," matches "peek"
// and a moved comma is never a disguise.
function tipWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/).filter((w) => w.length > 3));
}
function normalizeTip(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function overlapRatio(aWords, bWords) {
  if (!aWords.size || !bWords.size) return 0;
  let shared = 0;
  for (const w of aWords) if (bWords.has(w)) shared++;
  return shared / Math.min(aWords.size, bWords.size);
}

/**
 * Everything a tip must survive before anyone asks what it SAYS.
 *
 * Returns the cleaned text, or null to drop it. Rejection is used only where
 * there is no honest repair: shouting and the "lone" typo are fixed in place,
 * because dropping a good tip over formatting costs the player real coaching,
 * while a sentence with a missing noun cannot be guessed at.
 *
 * @param source 'ai' | 'library' | 'system'. Curated library and system text is
 *   authored complete, so the truncation and dropped-noun rules, which describe
 *   model failures, do not apply to it.
 */
function polishText(rawText, source) {
  if (rawText == null) return null;
  let t = String(rawText).replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // grammar tidy: kill em/en dashes (never allowed), fix punctuation spacing,
  // collapse doubled words (genericiser residue)
  t = t.replace(/\s*[—–]\s*/g, ', ')
       .replace(/\s+([.,!?;:])/g, '$1')
       .replace(/,\s*,/g, ',')
       .replace(/\b(a|an|the|to|your|and|or|of|on|in)\s+\1\b/gi, '$1')
       .replace(/\s{2,}/g, ' ')
       .trim();
  if (/^[a-z]/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);

  // STOP SHOUTING. The model sometimes returns a whole tip in capitals, and two
  // reached a player mid match: "SET UP A CROSSFIRE AT B MAIN WITH YOUR
  // SATELLITE SO THE FIRST ENTRY GETS TRADED." The advice is fine, the delivery
  // reads as an error message, so this is normalised rather than rejected:
  // dropping it would cost real coaching over a formatting slip. Short
  // all-caps runs are left alone because callouts legitimately shout (A, B, C,
  // KAY/O) and so do a few weapon names.
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 12 && (letters.replace(/[^A-Z]/g, '').length / letters.length) > 0.7) {
    t = t.charAt(0) + t.slice(1).toLowerCase();
    // Restore the site letters, which are single capitals in normal writing.
    t = t.replace(/\b([abc]) (site|main|long|short|link|lobby|elbow|hall|tower|heaven)\b/gi,
      (m, l, w) => l.toUpperCase() + ' ' + w.charAt(0).toUpperCase() + w.slice(1));
  }

  // A POSSESSIVE WITH NOTHING AFTER IT. "SET UP A CROSSFIRE ON A SITE WITH
  // your, AND HOLD AN OFF-ANGLE" shipped exactly like that: the model dropped
  // the noun and carried on, so the sentence ends grammatically and the
  // truncation check, which only looks at the LAST word, saw nothing wrong.
  // Mid-sentence is precisely where that check cannot help.
  //
  // "a" IS CHECKED LOWERCASE ONLY, because "A" is a site. Case-insensitively
  // this rejected "four teammates hold A, so wait for a rotation", which is an
  // ordinary sentence. That is the second time the A site has been mistaken for
  // an English article here, the first being the truncation rule above.
  if (source === 'ai'
      && (/\b(your|their|his|her|my|our|the|an)\s*[,.]/i.test(t) || /\ba\s*[,.]/.test(t))) {
    return null;
  }

  // "You are lone in B Lobby" reached a player, and the same slip appeared in an
  // earlier session, so it is worth correcting rather than dropping: the tip is
  // otherwise good and the fix is unambiguous.
  t = t.replace(/\byou are lone\b/gi, 'you are alone')
       .replace(/\bis lone\b/gi, 'is alone');

  // must end on a complete sentence; otherwise rescue to the last one, else drop
  if (!/[.!?]["')]?$/.test(t)) {
    const m = t.match(/^.*[.!?]["')]?/);
    if (m && m[0].trim().split(/\s+/).length >= 4) t = m[0].trim();
    else return null;
  }

  // malformed punctuation (any source)
  if (countOf(t, '(') !== countOf(t, ')')) return null;
  if (countOf(t, '"') % 2 !== 0) return null;
  // dangling-connective truncation is an AI artefact; curated library/system
  // tips are authored complete and may legitimately end on words like "in".
  if (source === 'ai' && TRUNCATION.some((re) => re.test(t))) return null;

  if (t.split(/\s+/).length > 30) return null;   // genuinely rambling (the card wraps to fit)

  return t;
}

module.exports = {
  polishText, cleanTip, tipWords, normalizeTip, overlapRatio, countOf,
  PREAMBLE, TRUNCATION,
};
