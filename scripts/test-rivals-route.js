'use strict';

/**
 * The Rivals reply contract and the draft gate.
 *
 * The two-line shape is load-bearing in exactly the way the Valorant one is: if
 * STATE silently stops parsing, tips keep appearing and simply stop being
 * informed by anything, and nothing errors. So the parser is tested against the
 * shapes a model actually produces, including the malformed ones.
 *
 * Run: npm run test:rivalsroute
 */
const path = require('path');

// The route module pulls in coach.js for the provider layer, which reads env at
// require time. These placeholders only need to exist, nothing here calls out.
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { __test } = require(path.join(__dirname, '..', 'server', 'routes', 'rivals.js'));
const { splitReply, lockedRoles, DRAFT_PROMPT, REVIEW_PROMPT } = __test;

let fails = 0;
const ok = (cond, what) => { if (!cond) { fails++; console.log(`FAIL  ${what}`); } else console.log(`ok    ${what}`); };

// ── The two-line contract ───────────────────────────────────────────────────
{
  const r = splitReply('Lock a Strategist, nobody on your team is healing.\nSTATE: {"phase":"draft","suggested":"Vanguard","locked":["Duelist","Duelist"],"timer":11}');
  ok(r.tip === 'Lock a Strategist, nobody on your team is healing.', `the tip is line 1 (${r.tip})`);
  ok(r.state && r.state.suggested === 'Vanguard', 'STATE parses');
  ok(r.state.timer === 11, 'numbers survive as numbers');
  ok(r.protocol === null, 'a real tip is not a protocol word');
}
{
  // Protocol words are the model working correctly, not a failure. Grading them
  // as tips scored a healthy Valorant run at 75% and would have blocked a deploy.
  ok(splitReply('SKIP').protocol === 'SKIP', 'SKIP is protocol');
  ok(splitReply('LOBBY').protocol === 'LOBBY', 'LOBBY is protocol');
  ok(splitReply('  skip  ').protocol === 'SKIP', 'protocol survives whitespace and case');
  ok(splitReply('SKIP').tip === '', 'and carries no tip');
}
{
  // A tip with no STATE must be reported as stateless rather than defaulted to
  // an empty object, which would read downstream as "read the screen, saw
  // nothing" instead of "the contract broke".
  const r = splitReply('Lock a Vanguard, there is no front line.');
  ok(r.tip.length > 0 && r.state === null, 'a missing STATE is null, not an empty object');
}
{
  const r = splitReply('Lock a Vanguard.\nSTATE: {"phase":"draft", broken json here');
  ok(r.tip === 'Lock a Vanguard.', 'a malformed STATE still yields the tip');
  ok(r.state === null, 'and the state is null rather than half parsed');
}
{
  // Models pad with prose and code fences. The tip must survive both.
  const r = splitReply('Lock a Strategist now.\nSTATE: {"phase":"draft","locked":["Vanguard"]}\nHope that helps!');
  ok(r.state && r.state.locked.join() === 'Vanguard', 'trailing prose after STATE does not break the parse');
}
ok(splitReply('').tip === '' && splitReply('').state === null, 'an empty reply is empty, not a crash');
ok(splitReply(null).protocol === null, 'a null reply does not throw');

// ── The roster is passed on RAW, which is not an oversight ──────────────────
// THE BUG THIS EXISTS FOR. Normalising and filtering here was the first version
// and it quietly disarmed every guard downstream. countRoles refuses to judge a
// roster containing anything it cannot read, so dropping the unreadable entries
// first means it never sees one: "Vanguard, Sorcerer, Duelist" arrives as a
// clean two-role roster, the trust check passes, and the coach gives confident
// advice about a team it only partly read.
{
  const raw = lockedRoles({ locked: ['Vanguard', 'Sorcerer', 'Duelist'] });
  ok(raw.length === 3, `an unreadable role is PRESERVED so the guard can see it (${raw.join()})`);
  ok(raw.includes('Sorcerer'), 'and it arrives unchanged rather than silently dropped');

  const { draftAdvice } = require(path.join(__dirname, '..', 'src', 'shared', 'rivals-draft.js'));
  ok(draftAdvice({ locked: raw, suggested: 'SUGGESTED PICK: STRATEGIST' }) === null,
    'so a half read roster produces NO advice, which is the whole point');
  ok(draftAdvice({ locked: ['Vanguard', 'Duelist'], suggested: 'SUGGESTED PICK: STRATEGIST' }) !== null,
    'while a fully readable roster still gets advice');
}
ok(lockedRoles({ locked: ['DPS', ' Tank ', 'Support'] }).join() === 'DPS,Tank,Support',
  'entries are trimmed but not translated, translation belongs to countRoles');
ok(lockedRoles({ locked: ['Vanguard', '', null, 42] }).join() === 'Vanguard',
  'blanks and non-strings are dropped, since they are not a role at all');
ok(lockedRoles({}).length === 0, 'no locked array is an empty roster');
ok(lockedRoles(null).length === 0, 'no state at all does not throw');

// ── The prompt states the constraint the frames proved ──────────────────────
// This is a real check, not decoration: the enemy roster genuinely is not on the
// hero select screen, so the day someone "improves" the prompt by asking for the
// enemy comp, the model starts inventing one and every draft tip goes with it.
ok(/ENEMY TEAM IS NOT ON THIS SCREEN/i.test(DRAFT_PROMPT),
  'the draft prompt states that the enemy team is not visible');
ok(/SUGGESTED PICK/.test(DRAFT_PROMPT),
  'and tells the model to read the game’s own printed recommendation');
ok(/Never invent a number that is not printed/i.test(REVIEW_PROMPT),
  'the review prompt forbids inventing numbers');
ok(/GROUPED BY ROLE/i.test(REVIEW_PROMPT),
  'and states the scoreboard grouping the frames showed');
for (const p of [DRAFT_PROMPT, REVIEW_PROMPT]) {
  ok(/Reply in EXACTLY two lines/.test(p), 'both prompts carry the two-line contract');
}

// No em or en dashes anywhere in the prompts, which is a hard rule for anything
// the model is shown, since it copies the punctuation it is given.
for (const [name, p] of [['draft', DRAFT_PROMPT], ['review', REVIEW_PROMPT]]) {
  ok(!/[—–]/.test(p), `the ${name} prompt has no em or en dashes`);
}

console.log(fails ? `\n${fails} failure(s)` : '\nall rivals route checks passed');
process.exit(fails ? 1 : 0);
