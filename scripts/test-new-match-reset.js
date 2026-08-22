'use strict';

/**
 * A second match in one session has to be allowed to be a different map.
 *
 * The new-match reset cleared matchContext.map so the map could be re-read, but
 * left the LABEL FINGERPRINT from the previous match in place. applyMapRead
 * returns immediately while mapConfirmedByLabels is set:
 *
 *     if (this.mapConfirmedByLabels) return;
 *
 * so after one match had been confirmed from printed labels, the next match
 * could never lock a map at all. It sat permanently unknown, and an unknown map
 * makes the callout gate reject every named callout, so the coach spent a whole
 * match unable to say where anything was. The stale seenLabels made it worse by
 * filtering the new map's labels against the old map's candidates.
 *
 * Whatever a match reset means, it cannot mean "half the map state".
 *
 * Run: npm run test:newmatch
 */
const path = require('path');
const CoachingEngine = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// Labels the game prints beside the minimap. These two together occur on
// exactly one map, which is what lets the fingerprint be decisive.
const SUNSET_LABELS = ['B Market', 'Mid Top'];

/** A session that has played most of a match on a label-confirmed map. */
function matchInProgress() {
  const e = new CoachingEngine({});
  e.updateMatchContext({ roundNumber: 9, teamScore: 5, enemyScore: 4, phase: 'active', side: 'attack' });
  for (const l of SUNSET_LABELS) e.applyLocationLabel(l);
  return e;
}

console.log('a match confirmed from the printed labels:');
const warm = matchInProgress();
check('  the map was identified', !!warm.matchContext.map, 'the fingerprint should have resolved');
check('  and locked by labels', warm.mapConfirmedByLabels === true);
const firstMap = warm.matchContext.map;
console.log(`        (identified as ${firstMap} from ${SUNSET_LABELS.join(' + ')})`);

console.log('\nthe model cannot overturn a label lock, which must not regress:');
{
  const e = matchInProgress();
  e.applyMapRead('Ascent');
  e.applyMapRead('Ascent');
  check('  two agreeing model reads are refused', e.matchContext.map === firstMap,
    `became ${e.matchContext.map}`);
}

console.log('\nnow a NEW MATCH starts in the same session:');
{
  const e = matchInProgress();
  // Round falls back and both scores reset: the agreement bar the reset needs.
  e.updateMatchContext({ roundNumber: 1, teamScore: 0, enemyScore: 0, phase: 'buy' });

  check('  the map was cleared', e.matchContext.map === null, `still ${e.matchContext.map}`);
  check('  THE LABEL LOCK WAS CLEARED TOO', e.mapConfirmedByLabels === false,
    'this is the assertion the whole file exists for');
  check('  the old labels are gone', (e.seenLabels || []).length === 0,
    `still holding ${(e.seenLabels || []).join(', ')}`);
  check('  no stale doubt', !e.mapDoubt && !e.mapChallenger);
  check('  the map is not flagged uncertain', e.matchContext.mapUncertain === false);

  // The point of clearing it: the new match can now lock its own map.
  e.applyMapRead('Ascent');
  check('  one read does not lock yet', e.matchContext.map === null);
  e.applyMapRead('Ascent');
  check('  TWO AGREEING READS LOCK THE NEW MAP', e.matchContext.map === 'Ascent',
    `got ${e.matchContext.map}, so the new match could never be coached with callouts`);
}

console.log('\nand a new match can be identified from its own labels:');
{
  const e = matchInProgress();
  e.updateMatchContext({ roundNumber: 1, teamScore: 0, enemyScore: 0, phase: 'buy' });
  e.applyLocationLabel('A Wine');          // occurs on exactly one map: Ascent
  e.applyLocationLabel('B Boat House');
  check('  the fingerprint resolves again', !!e.matchContext.map, 'the new labels should identify a map');
  check('  and it is the new match\'s map, not the old one',
    e.matchContext.map && e.matchContext.map.toLowerCase() === 'ascent',
    `got ${e.matchContext.map}, previous match was ${firstMap}`);
  check('  locked by labels again', e.mapConfirmedByLabels === true);
}

console.log('\na live match is never reset by one odd read:');
{
  const e = matchInProgress();
  // Round falls back but the scores do not agree, so this is a misread digit.
  e.updateMatchContext({ roundNumber: 1, teamScore: 5, enemyScore: 4 });
  check('  the map lock survives', e.matchContext.map === firstMap);
  check('  the label lock survives', e.mapConfirmedByLabels === true);
  check('  the labels survive', (e.seenLabels || []).length > 0);
}

console.log('\nstarting a session clears it too:');
{
  const e = matchInProgress();
  e.stop();
  e.start();
  check('  label lock cleared', e.mapConfirmedByLabels === false);
  check('  labels cleared', (e.seenLabels || []).length === 0);
  check('  doubt cleared', !e.mapDoubt && !e.mapChallenger);
  e.stop();
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
