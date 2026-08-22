'use strict';

/**
 * Hero select advice, and the two things the real capture frames settled.
 *
 * The frames showed the enemy team is NOT on screen at hero select, so the
 * feature as originally planned, "they have three dive heroes, take Namor",
 * cannot be built. Anything a tip says about the enemy comp at draft is
 * invented, and most of the cases below exist to keep that out.
 *
 * They also showed the game prints SUGGESTED PICK: <ROLE> itself, which is a
 * deterministic fact rather than a model opinion, so it beats the model's own
 * count of six small portraits.
 *
 * Run: npm run test:rivalsdraft
 */
const path = require('path');
const { draftAdvice, draftTipAllowed, readSuggested } =
  require(path.join(__dirname, '..', 'src', 'shared', 'rivals-draft.js'));

let fails = 0;
const ok = (cond, what) => { if (!cond) { fails++; console.log(`FAIL  ${what}`); } else console.log(`ok    ${what}`); };

// ── Reading the printed banner ──────────────────────────────────────────────
ok(readSuggested('SUGGESTED PICK: VANGUARD') === 'Vanguard', 'reads the banner exactly as printed');
ok(readSuggested('suggested pick vanguard') === 'Vanguard', 'reads it without the colon');
ok(readSuggested('the game suggests a Strategist') === 'Strategist', 'reads a paraphrase');
ok(readSuggested('SUGGESTED PICK: DPS') === 'Duelist', 'maps the game’s own role words');
ok(readSuggested('') === null, 'an unreadable banner is null, not a guess');
ok(readSuggested('there is a hero picker on the right') === null, 'unrelated text yields nothing');

// ── The readable roster outranks the printed banner ─────────────────────────
{
  // Both witnesses agree, which is the confident case.
  const a = draftAdvice({ locked: ['Vanguard', 'Vanguard', 'Strategist'], suggested: 'SUGGESTED PICK: DUELIST' });
  ok(a && a.role === 'Duelist', `agreement gives the obvious answer (${a && a.role})`);
  ok(a && a.agreed === true, 'and is reported as agreement');
}
{
  // THE CASE THE CAPTURE FRAMES ARGUED. The banner read VANGUARD across four
  // frames of one real draft, 22s down to 2s, while the team slots filled up,
  // and that match's scoreboard shows a finished 2-2-2 with the player on a
  // Duelist. Following the banner there would have talked them out of the right
  // pick with two seconds left, so the roster decides and the banner is kept
  // only to show the disagreement.
  const a = draftAdvice({
    locked: ['Vanguard', 'Vanguard', 'Duelist', 'Strategist', 'Strategist'],
    suggested: 'SUGGESTED PICK: VANGUARD',
  });
  ok(a && a.role === 'Duelist', `the roster decides when the two disagree (${a && a.role})`);
  ok(a && a.source === 'comp', 'and the source says so');
  ok(a && a.printed === 'Vanguard', 'the banner is kept rather than discarded');
  ok(a && a.agreed === false, 'and the disagreement is surfaced');
}
{
  // No banner at all: the arithmetic was already doing the work.
  const a = draftAdvice({ locked: ['Vanguard', 'Duelist', 'Duelist'], suggested: null });
  ok(a && a.role === 'Strategist' && a.source === 'comp', `without a banner the comp decides (${a && a.role})`);
  ok(/nobody is healing/.test(a.why), `and explains what is missing (${a.why})`);
  ok(a.printed === null, 'and records that there was no banner');
}
{
  // The banner's genuinely better case: the roster could not be read at all, so
  // there is no arithmetic to prefer and the printed role is all there is.
  const a = draftAdvice({ locked: [], suggested: 'SUGGESTED PICK: VANGUARD' });
  ok(a && a.role === 'Vanguard' && a.source === 'comp',
    'an empty roster still resolves, since every role is missing');
}

// ── Refusing to advise on a roster it cannot trust ──────────────────────────
ok(draftAdvice({ locked: ['Vanguard', 'Sorcerer'], suggested: null }) === null,
  'one unreadable role means no advice at all');
ok(draftAdvice({ locked: ['Vanguard', 'Vanguard', 'Duelist', 'Duelist', 'Strategist', 'Strategist'] }) === null,
  'a full team has nothing to advise');
ok(draftAdvice({ locked: [], suggested: 'SUGGESTED PICK: VANGUARD' }).role === 'Vanguard',
  'an empty roster resolves to a role rather than staying silent');
ok(draftAdvice(null) === null, 'no draft at all is null');
ok(draftAdvice({ locked: ['Vanguard'], suggested: 'SUGGESTED PICK: NONSENSE' }).source === 'comp',
  'an unreadable banner leaves the arithmetic in charge rather than failing');

// ── Never make the comp worse ───────────────────────────────────────────────
{
  // A banner naming a role that is already full cannot drag the advice there,
  // because the roster is what decides and it says Duelist.
  const a = draftAdvice({ locked: ['Strategist', 'Strategist', 'Vanguard'], suggested: 'SUGGESTED PICK: STRATEGIST' });
  ok(a && a.role === 'Duelist', `a full role in the banner is ignored (${a && a.role})`);
  ok(a && a.printed === 'Strategist', 'though the banner is still reported');
}
{
  // And when only the banner is available and it would overfill, pickHelps
  // refuses rather than making the comp worse.
  const a = draftAdvice({ locked: ['Vanguard', 'Vanguard', 'Duelist', 'Duelist', 'Strategist'], suggested: 'SUGGESTED PICK: VANGUARD' });
  ok(a && a.role === 'Strategist', `the last seat is filled by what is missing (${a && a.role})`);
}

// ── The enemy gate, the reason this file exists ─────────────────────────────
const draft = { locked: ['Vanguard', 'Duelist', 'Duelist'], suggested: 'SUGGESTED PICK: STRATEGIST' };
const enemyClaims = [
  'They have three dive heroes and no shield, so take a Strategist who can peel.',
  'Their comp is stacked on Duelists, pick a Strategist.',
  'The enemy team has two Vanguards, so you want a Strategist here.',
  'They are running a dive comp, so go Strategist.',
  'The other team has no healer, take a Strategist and punish it.',
];
for (const t of enemyClaims) {
  const v = draftTipAllowed(t, draft);
  ok(v.ok === false, `blocked: ${t.slice(0, 54)}`);
}

// The same advice, without claiming to see the enemy, is fine.
{
  const good = 'Nobody on your team is healing, so lock a Strategist before the timer runs out.';
  const v = draftTipAllowed(good, draft);
  ok(v.ok === true, `allowed: ${good.slice(0, 54)}`);
}

// Naming the wrong role is caught even when the sentence is otherwise clean.
{
  const v = draftTipAllowed('Take a Vanguard, your team needs a front line.', draft);
  ok(v.ok === false && /needs Strategist/.test(v.why), `wrong role is refused (${v.why})`);
}
ok(draftTipAllowed('', draft).ok === false, 'an empty tip is refused');
ok(draftTipAllowed('Lock a Strategist.', { locked: ['Vanguard', 'Sorcerer'] }).ok === false,
  'no tip escapes on a roster that could not be read');

console.log(fails ? `\n${fails} failure(s)` : '\nall rivals draft checks passed');
process.exit(fails ? 1 : 0);
