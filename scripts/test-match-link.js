'use strict';

/**
 * Deciding whether a tracker match is the one a coaching session watched.
 *
 * This refused a real match and the session was graded with no scoreboard at
 * all. The reason was that it compared START times: the match began more than
 * the 20 minute lead before the player hit Start, so it was rejected for
 * "starting before the session" despite being the only game they played and
 * still being in progress the whole time coaching ran.
 *
 * Start time is the wrong question. What makes a match the coached one is that
 * it was BEING PLAYED while the coach was watching, so the test is overlap. The
 * tracker never reports an end time, but it does report the scoreline, and the
 * round count that falls out of it estimates the length closely enough.
 *
 * The guard still refuses when in doubt: a session graded against somebody
 * else's scoreboard looks authoritative while being completely wrong, which is
 * worse than a session with no scoreboard.
 *
 * Run: npm run test:matchlink
 */
const path = require('path');
const { verifyCoachedMatch, roundsPlayed, matchEndEstimate } =
  require(path.join(__dirname, '..', 'src', 'main', 'services', 'match-link.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const MIN = 60 * 1000;
const T = (m) => new Date('2026-08-12T21:00:00Z').getTime() + m * MIN;

// The real failure: coaching started at 21:04 and ran to 21:13, on a match that
// had begun at 20:30 and was still going throughout.
const SESSION_START = T(4);
const SESSION_END = T(13);
const COACHED = { map: 'Breeze', agent: 'Iso' };

console.log('the match that was wrongly refused:');
const longMatch = { startedAt: T(-30), map: 'Breeze', agent: 'Iso', score: '13-11' };
const v = verifyCoachedMatch(longMatch, SESSION_START, SESSION_END, COACHED);
check('  a long match already underway links', v.ok, `refused: ${v.why}`);

console.log('\nround count is read from the scoreline:');
check('  "13-11" is 24 rounds', roundsPlayed({ score: '13-11' }) === 24);
check('  "5-2" is 7 rounds', roundsPlayed({ score: '5-2' }) === 7);
check('  a missing scoreline is 0', roundsPlayed({}) === 0);
check('  24 rounds runs about 40 minutes',
  Math.round((matchEndEstimate(longMatch) - longMatch.startedAt) / MIN) === 40);

console.log('\nit still refuses a match that was already over:');
// A short game that ended well before coaching began must not be linked.
const stale = { startedAt: T(-60), map: 'Breeze', agent: 'Iso', score: '5-2' };
const s = verifyCoachedMatch(stale, SESSION_START, SESSION_END, COACHED);
check('  a finished earlier match is refused', !s.ok, `linked it anyway: ${JSON.stringify(s)}`);

console.log('\nthe identity checks are unchanged:');
const wrongMap = verifyCoachedMatch({ startedAt: T(-10), map: 'Ascent', agent: 'Iso', score: '13-11' },
  SESSION_START, SESSION_END, COACHED);
check('  a different map is refused', !wrongMap.ok, wrongMap.why);

const wrongAgent = verifyCoachedMatch({ startedAt: T(-10), map: 'Breeze', agent: 'Jett', score: '13-11' },
  SESSION_START, SESSION_END, COACHED);
check('  a different agent is refused', !wrongAgent.ok, wrongAgent.why);

const nothingToCheck = verifyCoachedMatch({ startedAt: T(-10), score: '13-11' },
  SESSION_START, SESSION_END, {});
check('  timing alone is never enough', !nothingToCheck.ok, nothingToCheck.why);

const later = verifyCoachedMatch({ startedAt: T(40), map: 'Breeze', agent: 'Iso', score: '13-11' },
  SESSION_START, SESSION_END, COACHED);
check('  a match starting well after the session is refused', !later.ok, later.why);

console.log('\nwith no scoreline to estimate from, the old lead window still applies:');
const noScore = verifyCoachedMatch({ startedAt: T(-30), map: 'Breeze', agent: 'Iso' },
  SESSION_START, SESSION_END, COACHED);
check('  unknown length beyond the lead is refused', !noScore.ok, noScore.why);
const noScoreRecent = verifyCoachedMatch({ startedAt: T(-5), map: 'Breeze', agent: 'Iso' },
  SESSION_START, SESSION_END, COACHED);
check('  unknown length inside the lead still links', noScoreRecent.ok, noScoreRecent.why);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
