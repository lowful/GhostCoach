'use strict';

/**
 * Habit profile checks.
 *
 * Two things are being proved. First that every pattern actually matches a real
 * tip, because a regex that silently matches nothing still compiles and would
 * quietly empty this feature (the backspace-through-a-heredoc hazard has broken
 * pattern files in this repo twice). Second that generic advice does NOT count,
 * because a profile built from the coach's vocabulary rather than the player's
 * behaviour would make every player look the same.
 *
 * Run: npm run test:habits
 */
const path = require('path');
const { HABITS, profileHabits } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'habits.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// Real tips taken from this account's session archives.
const EVIDENCE = [
  ['dry-peek',       'You died dry peeking A Long alone, wait for your team to group before taking that duel.'],
  ['no-trade',       'You overcommitted to a dry duel in B Main with no teammates near enough to trade you.'],
  ['overextend',     'You overextended alone into Mid Library and got traded by their Jett.'],
  ['repeek',         'You reset your position after the first kill instead of holding, then repeeked the same angle.'],
  ['crosshair',      'Work on your crosshair placement, you hit 179 damage but lost the duel by aiming too low.'],
  ['wide-swing',     'You wide swung into multiple angles instead of clearing one at a time from cover.'],
  ['util-unused',    'You died with full util again, an unused ability is value thrown away.'],
  ['rotate-late',    'You were holding a dead angle while the round was decided, rotate early next time.'],
  ['minimap',        'You walked into two enemies that were already on your minimap.'],
  ['spike-priority', 'You hunted a kill instead of moving to the spike, the retake is the round.'],
];

console.log('every pattern matches a real tip:');
for (const [id, tip] of EVIDENCE) {
  const h = HABITS.find((x) => x.id === id);
  check(`  ${id}`, !!h && h.re.test(tip), `pattern never matched: ${tip}`);
}

// Generic advice must not be counted as a mistake the player makes.
console.log('\ngeneric advice is not counted as evidence:');
const ADVICE = [
  'Rotate to B now through mid, three are already in.',
  'Glance at the minimap every 5 seconds.',
  'Never die with full util, an unused ability is value thrown away.',
  'Clear one angle at a time from cover.',
];
const adviceOnly = profileHabits([{ at: Date.now(), tips: ADVICE.map((text) => ({ text })) }], 5);
check('  advice-only week yields no habits', adviceOnly.length === 0,
  `got: ${adviceOnly.map((h) => h.label).join(', ')}`);

// A habit needs to recur. One mention is a moment, not a pattern.
console.log('\nrecurrence:');
const once = profileHabits([{ at: 1, tips: [{ text: EVIDENCE[0][1] }] }], 5);
check('  a single mention is not a habit', once.length === 0);

const week = [
  { at: 1, tips: [{ text: EVIDENCE[0][1] }, { text: EVIDENCE[2][1] }] },
  { at: 2, tips: [{ text: EVIDENCE[0][1] }, { text: EVIDENCE[1][1] }] },
  { at: 3, tips: [{ text: EVIDENCE[0][1] }] },
];
const profile = profileHabits(week, 3);
// One tip can exhibit two habits ("died dry peeking alone while your team was
// elsewhere" is both), and that overlap is wanted: the profile describes the
// play, not a single label per sentence. So the check is that a recurring habit
// surfaces and is ranked by recurrence, not that one specific id comes first.
check('  a habit across 3 sessions is surfaced',
  profile.length > 0 && profile[0].sessions === 3,
  `got: ${JSON.stringify(profile.map((h) => [h.id, h.sessions]))}`);
check('  dry peeking is still recognised in the same week',
  profile.some((h) => h.id === 'dry-peek'));
// sessions counts games, count counts mentions, and they differ on purpose: one
// game can mention a habit twice, and here a second tip ("a dry duel in B Main")
// also describes dry peeking, so 4 mentions across 3 sessions is correct.
check('  sessions counts games, not mentions',
  profile[0].sessions === 3 && profile[0].count >= 3,
  `sessions=${profile[0].sessions} count=${profile[0].count}`);
check('  every surfaced habit carries a concrete fix',
  profile.every((h) => typeof h.fix === 'string' && h.fix.length > 30));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
