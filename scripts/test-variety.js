'use strict';

/**
 * Tip variety: does the coach notice when it is repeating itself?
 *
 * Measured on a real 12 minute session, 14 of the 23 tips the player saw were
 * the same idea in new words, "stay tight and wait for your team", two of them
 * almost verbatim 109 seconds apart. The variety guard was not broken, it simply
 * had no entry for the advice this model actually favours: 10 of 11 repeats were
 * invisible to it, while it correctly policed crossfires and off-angles the
 * model rarely reached for.
 *
 * The topic labels had the same shape of bug. topicOf returns the FIRST match
 * and "economy" led the list matching bare weapon names, so "holding that angle
 * alone with a pistol" was reported to the model as economy advice. It was told
 * to stop covering a subject it had never raised, and left free to repeat the
 * one it had.
 *
 * Every tip below is verbatim from that session.
 *
 * Run: npm run test:variety
 */
const path = require('path');
const fs = require('fs');

// PLAY_PATTERNS and topicOf are module-private, so they are read out of the
// source. Deliberate: it keeps them under test without widening the engine's
// public surface just for a test.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'), 'utf8');

const patternBlock = SRC.match(/const PLAY_PATTERNS = \[([\s\S]*?)\n\];/);
const PLAY_PATTERNS = eval(`[${patternBlock[1]}]`);   // eslint-disable-line no-eval
const topicBody = SRC.match(/function topicOf\(text\) \{[\s\S]*?\n\}/)[0];
const topicOf = eval(`(${topicBody})`);               // eslint-disable-line no-eval

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};
const playIn = (t) => (PLAY_PATTERNS.find(([, re]) => re.test(t)) || [null])[0];

// The repeated advice, verbatim, that the guard could not see.
const REPEATS = [
  'Wait for your team to commit to a site before you push from A Lobby, solo entries here get traded easily.',
  'Stay with the group as you push, pushing A Lobby alone on pistol rounds gets traded easily.',
  'Stay with the group in A Lobby, pushing alone on pistol rounds gets you traded before your team can help.',
  'You are holding A Vent alone while four teammates hit A site, so stay tight to the corner and wait for them to clear before you peek out.',
  'You are holding Mid Top alone with a pistol while four teammates hit A, so stay tight to cover and wait for them to clear before you peek out.',
  'Stay tight to the corner until your team clears, because holding that angle alone with a pistol is a free trade.',
  'Stay tight to the doorframe and let them cross into your head, because solo peeking A Main with a Sheriff is a guaranteed trade.',
  'You died holding A Main alone with a pistol while four teammates hit A, so stay tight to cover and wait for them to clear before you peek out.',
  'Stay low behind the ledge, your pistol is useless at range and you are exposed while teammates clear A site.',
];

console.log('every repeated tip is now recognised as a play:');
for (const t of REPEATS) {
  check(`  ${playIn(t) ? String(playIn(t)).padEnd(11) : 'STILL UNSEEN'} ${t.slice(0, 52)}`, !!playIn(t));
}

console.log('\ntips that genuinely differ keep their own identity:');
// These were the good, varied tips from the same session. They must NOT all
// collapse into one play, or the guard would suppress real coaching.
const VARIED = [
  ['Save your dash for the actual entry, using it to push through smoke just wastes your escape tool before the fight starts.', 'utility'],
  ['You are last alive in a 1v2 post-plant, isolate the closer threat first and use the spike timer to bait their rotation.', 'spike'],
  ['You are buying full on A site with your team, use your smoke to seal Mid and stop them from watching your attack.', 'utility'],
  ['You died peeking too wide from Mid Catwalk without utility to clear the angle or a teammate to trade for you.', 'utility'],
];
for (const [tip, topic] of VARIED) {
  check(`  ${topic.padEnd(11)} ${tip.slice(0, 52)}`, topicOf(tip) === topic,
    `got "${topicOf(tip)}"`);
}

console.log('\na weapon name is not economy advice:');
check('  "holding that angle alone with a pistol" is positioning',
  topicOf('Stay tight to the corner until your team clears, because holding that angle alone with a pistol is a free trade.') === 'positioning',
  `got "${topicOf('Stay tight to the corner until your team clears, because holding that angle alone with a pistol is a free trade.')}"`);
check('  real economy advice is still economy',
  topicOf('You are on a half buy, so save this round and go full next instead of forcing.') === 'economy',
  `got "${topicOf('You are on a half buy, so save this round and go full next instead of forcing.')}"`);
check('  a full buy call is still economy',
  topicOf('Buy a full rifle and shields this round, you can afford it.') === 'economy');

console.log('\nthe repeated advice no longer all reports as one wrong topic:');
const topics = new Set(REPEATS.map(topicOf));
check('  it reports as positioning or teamwork, never economy',
  !topics.has('economy'), `got topics: ${[...topics].join(', ')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
