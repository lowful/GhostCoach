'use strict';

/**
 * Developer joke tips.
 *
 * The joke itself is trivial. The tests that matter are the ones proving it
 * cannot reach a normal user, and cannot contaminate the record.
 *
 * A fake tip that leaked into state.tips would flow into the session archive,
 * the session grade, the habit profile and the weekly report. "Uninstall."
 * counted as coaching would drag a real score down and could surface as a
 * recurring mistake, which corrupts the exact numbers this app spends its life
 * keeping honest. So the controller broadcasts it straight to the overlay and
 * never calls pushTip, and that separation is asserted here against the real
 * source rather than trusted.
 *
 * Run: npm run test:joke
 */
const fs = require('fs');
const path = require('path');
const joke = require(path.join(__dirname, '..', 'src', 'main', 'services', 'joke-tips.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};
const store = (obj) => ({ get: (k) => obj[k] });

console.log('off unless explicitly switched on:');
check('  a default install gets nothing', joke.next(store({})) === null);
check('  false is off', joke.next(store({ devJokeTips: false })) === null);
check('  a truthy-but-not-true value is still off',
  joke.next(store({ devJokeTips: 'yes' })) === null,
  'only exactly true may enable this');
check('  a broken store cannot enable it',
  joke.next({ get() { throw new Error('no store'); } }) === null);

console.log('\nswitched on, it produces tips:');
joke.reset();
const on = store({ devJokeTips: true });
const a = joke.next(on), b = joke.next(on);
check('  returns a tip', typeof a === 'string' && a.length > 0);
check('  cycles instead of repeating', a !== b, `${a} then ${b}`);
check('  wraps around the list', (() => {
  joke.reset();
  const seen = new Set();
  for (let i = 0; i < joke.DEFAULT_JOKES.length; i++) seen.add(joke.next(on));
  return seen.size === joke.DEFAULT_JOKES.length && joke.next(on) === joke.DEFAULT_JOKES[0];
})());

console.log('\nyour own list replaces the built-in one:');
joke.reset();
const mine = store({ devJokeTips: true, devJokeTipList: ['Skill issue.', 'Have you tried winning.'] });
check('  uses the configured lines', joke.next(mine) === 'Skill issue.');
check('  and only those', joke.next(mine) === 'Have you tried winning.');
joke.reset();
check('  an empty list falls back to the defaults',
  joke.next(store({ devJokeTips: true, devJokeTipList: [] })) === joke.DEFAULT_JOKES[0]);
joke.reset();
check('  junk entries are ignored',
  joke.next(store({ devJokeTips: true, devJokeTipList: [null, 42, '  '] })) === joke.DEFAULT_JOKES[0]);

console.log('\nIT MUST NOT REACH THE RECORD:');
const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
const body = (idx.match(/jokeTip\(\)\s*\{[\s\S]*?\n  \},/) || [''])[0];
check('  the joke action exists', body.length > 0);
check('  it never calls pushTip', body.length > 0 && !/pushTip\(/.test(body),
  'pushTip fills state.tips, which becomes the archive, the grade and the habit profile');
check('  it never touches state.tips', body.length > 0 && !/state\.tips/.test(body));
check('  it broadcasts to the overlay instead', /registry\.broadcast\(C\.PUSH_TIP/.test(body));
check('  and it is logged so a screenshot can be explained', /\[joke\]/.test(body));

// The AI decision log records what the MODEL produced. A joke never goes
// through the engine, so it cannot appear there, but assert the path anyway.
check('  it does not write to the AI log', body.length > 0 && !/recordAiFrame|diagnostics/.test(body));

console.log('\nand it is not discoverable by a normal user:');
const settingsHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings', 'index.html'), 'utf8');
check('  no Settings control exists for it', !/devJokeTips/.test(settingsHtml));
const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'register-ipc.js'), 'utf8');
check('  it is not exposed through the config bridge', !/devJokeTips/.test(ipc),
  'exposing it would let any renderer read or advertise the flag');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
