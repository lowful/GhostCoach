'use strict';

/**
 * The game registry, and the promise that an unfinished game is never sold.
 *
 * The dangerous failure here is not a crash, it is a plausible lie: a player
 * selects Marvel Rivals, the app turns navy and gold, and the Valorant engine
 * keeps coaching underneath. Everything would look right and every tip would be
 * about a game they are not playing. So `coaching: false` is enforced rather
 * than trusted, and the picker hides a game until its coach genuinely exists.
 *
 * Run: npm run test:games
 */
const path = require('path');
const fs = require('fs');
const games = require(path.join(__dirname, '..', 'src', 'shared', 'games.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

console.log('an unfinished game is not offered to players:');
check('  only coachable games are listed',
  games.list().every((g) => g.coaching), games.list().map((g) => g.id).join(', '));
check('  Marvel Rivals is hidden while its coach does not exist',
  !games.list().some((g) => g.id === 'rivals'),
  'it would be selectable and coached by the Valorant engine');
check('  and visible for development', games.list(true).some((g) => g.id === 'rivals'));
check('  canCoach agrees', games.canCoach('valorant') === true && games.canCoach('rivals') === false);

console.log('\nlookups never throw:');
check('  an unknown id falls back to the default', games.get('fortnite').id === 'valorant');
check('  so do null and undefined', games.get(null).id === 'valorant' && games.get().id === 'valorant');
check('  ids are case insensitive', games.get('VALORANT').id === 'valorant');

console.log('\nevery game is complete enough to render:');
for (const g of Object.values(games.GAMES)) {
  check(`  ${g.id}`, !!(g.id && g.label && g.cadence && typeof g.coaching === 'boolean'),
    JSON.stringify(g).slice(0, 90));
}

console.log('\nthe palette matches the stylesheet:');
// A palette declared here but absent from theme.css would silently do nothing,
// which is the same class of bug as a config key that is written and never read.
const theme = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shared', 'theme.css'), 'utf8');
for (const [id, g] of Object.entries(games.GAMES)) {
  if (!g.palette) continue;
  const block = theme.match(new RegExp(`:root\\[data-game="${id}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  check(`  ${id} has a :root[data-game] block`, !!block);
  if (!block) continue;
  const missing = Object.keys(g.palette).filter((t) => !block[1].includes(t + ':'));
  check(`  ${id} declares every token it claims`, missing.length === 0, `missing: ${missing.join(', ')}`);
}

console.log('\nstatus and structural tokens are NOT overridden per game:');
// A win must be green in every game, and radii/motion/type are shared. The
// first attempt at the Rivals block swallowed --r-sm, --ease, --lift and
// --font, which would have stripped Valorant of its radii and typeface.
const MUST_NOT_MOVE = ['--good', '--bad', '--warn', '--r-sm', '--r-md', '--ease', '--lift', '--font', '--t-fast'];
for (const [id, g] of Object.entries(games.GAMES)) {
  if (!g.palette) continue;
  const bad = MUST_NOT_MOVE.filter((t) => Object.keys(g.palette).includes(t));
  check(`  ${id} leaves shared tokens alone`, bad.length === 0, `overrides: ${bad.join(', ')}`);
  const block = theme.match(new RegExp(`:root\\[data-game="${id}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (block) {
    const leaked = MUST_NOT_MOVE.filter((t) => block[1].includes(t + ':'));
    check(`  ${id} block does not swallow shared tokens`, leaked.length === 0,
      `found in the block: ${leaked.join(', ')}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
