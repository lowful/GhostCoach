'use strict';

/**
 * The League data layer: the generated roster, the champion service and the
 * curriculum.
 *
 * The curriculum assertions are the interesting ones. Content is the easiest
 * thing in a codebase to get quietly wrong, because a duplicated id or an
 * answer index pointing past the end of its options array does not throw, it
 * just teaches someone the wrong thing.
 */
const champs = require('../src/shared/lol-champions');
const curriculum = require('../src/shared/lol-curriculum');
const data = require('../src/shared/lol-data.generated.json');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); return; }
  console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  failures++;
}

// ── The generated roster ────────────────────────────────────────────────────
console.log('[lol] generated data');
{
  check('has a patch', typeof data.patch === 'string' && /^\d+\./.test(data.patch), data.patch);
  check('count is derived, not typed', data.count === data.champions.length,
    data.count + ' vs ' + data.champions.length);
  check('a real roster is present', data.champions.length >= 100, String(data.champions.length));

  const missingIcon = data.champions.filter((c) => !c.icon || !c.icon.startsWith('lol/champions/'));
  check('every champion has an icon path', missingIcon.length === 0, missingIcon.length + ' missing');

  const badRange = data.champions.filter((c) => c.range !== 'melee' && c.range !== 'ranged');
  check('range is derived for every champion', badRange.length === 0, badRange.map((c) => c.id).join(', '));

  const badTags = data.champions.filter((c) => !Array.isArray(c.tags) || !c.tags.length);
  check('every champion has at least one role tag', badTags.length === 0, badTags.map((c) => c.id).join(', '));

  // The icons are what the surface actually draws, so a path in the data with
  // no file behind it is a broken image rather than a fallback.
  const fs = require('fs');
  const path = require('path');
  const iconDir = path.join(__dirname, '..', 'assets', 'lol', 'champions');
  if (fs.existsSync(iconDir)) {
    const onDisk = new Set(fs.readdirSync(iconDir));
    const absent = data.champions.filter((c) => !onDisk.has(c.id + '.png'));
    check('every icon path has a file on disk', absent.length === 0,
      absent.slice(0, 5).map((c) => c.id).join(', '));
  } else {
    check('icon directory exists', false, 'run npm run sync:lol');
  }
}

// ── The champion service ────────────────────────────────────────────────────
console.log('\n[lol] champion lookups');
{
  check('by id', champs.champion('Ahri') !== null);
  check('by display name', champs.champion('Miss Fortune') !== null);
  check('punctuation and spacing do not matter',
    champs.champion("Kai'Sa") !== null && champs.champion('kaisa') !== null);

  // The silence rule, same as Rivals: unknown means null, never a guess.
  check('an unknown champion returns null', champs.champion('Notarealchampion') === null);
  check('empty input returns null', champs.champion('') === null && champs.champion(undefined) === null);

  check('byRole finds mages', champs.byRole('Mage').length > 10);
  check('byRole is case insensitive', champs.byRole('mage').length === champs.byRole('Mage').length);
  check('byRole on nonsense is empty', champs.byRole('Wizard').length === 0);

  const easy = champs.beginnerFriendly();
  check('beginnerFriendly returns only low difficulty',
    easy.every((c) => c.difficultyBand === 'low'), String(easy.length));

  // STARTERS names champions by id. A rename or removal upstream must break
  // here rather than render an empty card in the learn surface.
  const broken = [];
  for (const [lane, picks] of Object.entries(champs.STARTERS)) {
    for (const p of picks) if (!champs.champion(p.id)) broken.push(lane + ':' + p.id);
  }
  check('every STARTERS pick resolves to a real champion', broken.length === 0, broken.join(', '));
  const noWhy = Object.values(champs.STARTERS).flat().filter((p) => !p.why || p.why.length < 20);
  check('every starter says WHY', noWhy.length === 0, noWhy.map((p) => p.id).join(', '));
}

// ── The curriculum ──────────────────────────────────────────────────────────
console.log('\n[lol] curriculum');
{
  const all = curriculum.lessons();
  check('has lessons', all.length >= 10, String(all.length));

  const ids = all.map((l) => l.id);
  check('every lesson id is unique', new Set(ids).size === ids.length,
    ids.filter((id, i) => ids.indexOf(id) !== i).join(', '));

  const noBody = all.filter((l) => !Array.isArray(l.body) || l.body.length < 2);
  check('every lesson has a real body', noBody.length === 0, noBody.map((l) => l.id).join(', '));

  // A lesson names the mistake it fixes, which is the writing rule the file
  // sets for itself. Losing it turns the curriculum back into a topic list.
  const noMistake = all.filter((l) => !l.mistake || l.mistake.length < 15);
  check('every lesson names the mistake it fixes', noMistake.length === 0,
    noMistake.map((l) => l.id).join(', '));

  const noPractice = all.filter((l) => !Array.isArray(l.practice) || !l.practice.length);
  check('every lesson has practice', noPractice.length === 0, noPractice.map((l) => l.id).join(', '));

  // THE ONE THAT MATTERS. An answer index past the end of options does not
  // throw, it silently marks the right answer wrong forever.
  const badAnswer = [];
  for (const l of all) {
    for (const q of l.practice) {
      if (!Array.isArray(q.options) || q.options.length < 2) badAnswer.push(l.id + ' (options)');
      else if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
        badAnswer.push(l.id + ' (answer ' + q.answer + ' of ' + q.options.length + ')');
      } else if (!q.why || q.why.length < 20) badAnswer.push(l.id + ' (no explanation)');
    }
  }
  check('every answer index is inside its options, with an explanation',
    badAnswer.length === 0, badAnswer.join('; '));

  check('lesson() finds one', curriculum.lesson(ids[0]) !== null);
  check('lesson() on nonsense is null', curriculum.lesson('nope') === null);
}

// ── Progress ────────────────────────────────────────────────────────────────
console.log('\n[lol] progress');
{
  const ids = curriculum.lessons().map((l) => l.id);
  const none = curriculum.summarise([]);
  check('empty progress is 0%', none.done === 0 && none.pct === 0);
  check('total matches the curriculum', none.total === curriculum.lessonCount());

  const some = curriculum.summarise([ids[0], ids[1]]);
  check('counts what is done', some.done === 2);
  check('percentage is rounded sensibly', some.pct === Math.round((2 / ids.length) * 100));

  // A lesson removed in an update must not strand someone above 100% or at a
  // total they can never reach.
  const stale = curriculum.summarise([ids[0], 'a-lesson-that-was-deleted']);
  check('unknown ids are ignored', stale.done === 1, JSON.stringify(stale.done));
  check('never exceeds 100%', curriculum.summarise(ids.concat(['ghost'])).pct === 100);
  check('duplicates in progress do not inflate it',
    curriculum.summarise([ids[0], ids[0], ids[0]]).done <= curriculum.lessonCount());

  const byTrack = none.byTrack;
  check('per track totals add up to the whole',
    byTrack.reduce((n, t) => n + t.total, 0) === curriculum.lessonCount());
}

if (failures) {
  console.log('\nFAIL: ' + failures + ' League check(s) failed');
  process.exit(1);
}
console.log('\nPASS: the roster is derived, the lookups stay silent on unknowns, and the quiz answers point at real options');
