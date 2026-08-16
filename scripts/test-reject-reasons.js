'use strict';

/**
 * Two small bugs that both cost real tips, found by reading a session's reject
 * reasons.
 *
 * 1. THE A SITE IS NOT A DANGLING ARTICLE. The truncation detector rejects a tip
 *    ending on a bare "a", which is a good check: a reply cut off mid sentence
 *    really does end that way. But the pattern was case-insensitive, and in this
 *    game "A" is a SITE. "Do not step out alone since your team is grouped on A."
 *    is a complete sentence and was binned as cut off mid sentence. Three good
 *    tips went that way in one day over a capital letter.
 *
 * 2. THE REASON WAS COMPUTED AND THEN OVERWRITTEN. verifyTip records a specific
 *    reason for most refusals, then the caller unconditionally recorded "failed
 *    the final verify gate", and noteReject just assigns. A fifth of all
 *    rejected tips were logged as unexplained while the explanation existed one
 *    line earlier. Reject reasons are the main tool for diagnosing a session, so
 *    losing them is expensive.
 *
 * Run: npm run test:rejects
 */
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'), 'utf8');
// TRUNCATION now lives in tip-hygiene.js and is exported, so this imports it
// rather than scraping it out of source with a regex and eval. The scrape was
// only ever a workaround for it being private, and it broke the moment the
// rule moved, which is a fair demonstration of why it was the wrong approach.
const { TRUNCATION } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'tip-hygiene.js'));
const truncated = (t) => TRUNCATION.some((re) => re.test(String(t || '').trim()));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// Verbatim from a real session, all three rejected as "cut off mid sentence".
console.log('a tip ending on the A site is a complete sentence:');
const REAL = [
  'Keep your crosshair at head height, do not step out alone since your team is grouped on A.',
  'Stay tight to the wall, do not walk out into the open center while your team is committed A.',
  'Hold your angle behind that smoke, you are isolated in mid while your team hits A.',
];
for (const t of REAL) check(`  ...${t.slice(-46)}`, !truncated(t), 'still flagged as truncated');

console.log('\nand B and C sites were never affected, but check anyway:');
check('  ends on B', !truncated('Rotate through mid now, the spike just went down on B.'));
check('  ends on C', !truncated('Take the flank through garage and retake from C.'));

console.log('\ngenuine truncation is still caught:');
const CUT = [
  'Hold the angle and wait for your teammate to',
  'Use your smoke to block their vision of the',
  'Push through mid with your team and',
  'You should reposition after the kill, then take',
  'Stay behind cover and keep your',
  'Clear the corner slowly, do not use',
];
for (const t of CUT) check(`  "${t.slice(-34)}"`, truncated(t), 'a cut-off tip slipped through');

console.log('\na lowercase dangling article is still truncation:');
check('  "...so you can take a"', truncated('Wait for the flash, so you can take a'));
check('  "...so you can take a."', truncated('Wait for the flash, so you can take a.'));

console.log('\nthe specific reject reason survives instead of being overwritten:');
// The caller must only fall back to the generic reason when none was recorded.
const guard = /if \(!lastRejectReason\) noteReject\(`failed the final verify gate/;
check('  the generic reason is a fallback, not an overwrite', guard.test(SRC),
  'the caller still clobbers whatever verifyTip recorded');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
