'use strict';

/**
 * The tip glyph lexicon.
 *
 * Tokenising is a pure function of the tip text, so it tests offline with no
 * Electron and no DOM. That is why tokenize() is kept free of both.
 *
 * EVERY PATTERN NEEDS A NEGATIVE. A lexicon that matches short tokens is one
 * careless regex away from lighting up ordinary English, and in this repo that
 * has already happened three times with the letter "a" alone, once inside a
 * checker written to prevent it. A test that only proves "A Main" matches would
 * pass just as happily on a pattern that also matches every article on screen.
 */
const path = require('path');
const tv = require('../src/renderer/shared/tip-visuals.js');
const data = require('../src/shared/valorant-data.generated.json');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); return; }
  console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  failures++;
}

/** kinds marked in a tip, in order */
const kinds = (t) => tv.tokenize(t).filter((x) => x.type === 'mark').map((x) => x.kind);
/** the marked substrings */
const marks = (t) => tv.tokenize(t).filter((x) => x.type === 'mark').map((x) => x.value);
const has = (t, kind) => kinds(t).includes(kind);

console.log('[tip-visuals] the lexicon');

// ── The vocabulary has not drifted from the generated data ──────────────────
{
  const gen = Object.keys(data.mapCallouts || {}).sort();
  check('callout list matches the generated data',
    JSON.stringify([...tv.CALLOUTS].sort()) === JSON.stringify(gen),
    'run npm run sync:valorant then update CALLOUTS in tip-visuals.js');

  const agents = Object.keys(data.agents || {}).sort();
  check('agent list matches the generated data',
    JSON.stringify([...tv.AGENTS].sort()) === JSON.stringify(agents),
    'agents changed in the generated data; update AGENTS in tip-visuals.js');
}

// ── Sites: the trap ─────────────────────────────────────────────────────────
{
  check('marks "A Main"', has('hold your crossfire on A Main', 'site'));
  check('marks "B site"', has('they are hitting B site', 'site'));
  check('marks "C Long"', has('watch C Long', 'site'));
  check('marks bare "mid"', has('they rotated through mid', 'site'));

  // The three that have actually broken rules in this repo.
  check('does NOT mark the article in "take a fight"', !has('do not take a fight you cannot trade', 'site'));
  check('does NOT mark the article in "hold a corner"', !has('hold a corner and wait', 'site'));
  check('does NOT mark "a long time"', !has('you held that angle a long time', 'site'),
    JSON.stringify(marks('you held that angle a long time')));
  check('does NOT mark "a short rotate"', !has('that was a short rotate', 'site'));
  // "mid" the word, not the lane.
  check('does NOT mark "mid round"', !has('do not swap mid round', 'site'));
  check('does NOT mark "midair"', !has('never shoot midair', 'site'));
}

// ── Agents: ordinary English words that are also agent names ────────────────
{
  check('marks "Sova" ', has('let Sova drone first', 'agent'));
  check('marks "KAY/O"', has('KAY/O can suppress that', 'agent'));
  check('does NOT mark lowercase "breach the site"', !has('breach the site together', 'agent'),
    JSON.stringify(marks('breach the site together')));
  check('does NOT mark lowercase "chamber"', !has('clear the chamber before you push', 'agent'));
  check('does NOT mark lowercase "sage"', !has('play it safe and sage the wall', 'agent'));
  check('DOES mark capitalised "Breach"', has('Breach can stun through that wall', 'agent'));
}

// ── Callouts and directions ─────────────────────────────────────────────────
{
  check('marks a named callout', has('he is holding hookah', 'callout'));
  check('marks "rotate"', has('rotate now', 'rotate'));
  check('marks "rotating"', has('they are rotating', 'rotate'));
  check('marks "push"', has('push together', 'push'));
  check('marks "fall back"', has('fall back to spawn', 'fallback'));
  check('marks "lurk"', has('let him lurk', 'flank'));
}

// ── Structure ───────────────────────────────────────────────────────────────
{
  const t = 'They rotated through mid, hold your crossfire on A Main and let Sova entry.';
  const toks = tv.tokenize(t);
  check('reassembles the tip EXACTLY', toks.map((x) => x.value).join('') === t,
    JSON.stringify(toks.map((x) => x.value).join('')));
  check('marks several kinds in one tip', new Set(kinds(t)).size >= 3, JSON.stringify(kinds(t)));
  check('empty text yields nothing', tv.tokenize('').length === 0);
  check('undefined text yields nothing', tv.tokenize(undefined).length === 0);

  // Stateful /g regexes are shared between calls; a missing lastIndex reset
  // makes the SECOND call silently miss.
  const once = kinds('rotate to A Main');
  const twice = kinds('rotate to A Main');
  check('is idempotent across calls', JSON.stringify(once) === JSON.stringify(twice),
    JSON.stringify(once) + ' then ' + JSON.stringify(twice));

  // Every library tip must survive the tokenizer unchanged.
  const samples = [
    'Clear one angle at a time from cover, never wide swing into multiple uncleared angles at once.',
    'Counter strafe before shooting, release your movement key, tap the opposite one, and fire the first accurate shot.',
    'Glance at the minimap every 5 seconds, most deaths were visible on the map before they happened.',
  ];
  const intact = samples.every((s) => tv.tokenize(s).map((x) => x.value).join('') === s);
  check('library tips reassemble exactly', intact);
}

// ── The cap, which is what keeps emphasis meaning something ─────────────────
{
  // Six markable terms in one sentence. Uncapped this produced five bold runs
  // on one card, which reads as noise rather than emphasis.
  const busy = 'Let Sova drone A Main, then rotate through mid, push and hold hookah.';
  check('uncapped marks everything it finds', kinds(busy).length >= 5, JSON.stringify(kinds(busy)));

  const capped = tv.tokenize(busy, { max: 3 }).filter((x) => x.type === 'mark');
  check('cap limits the marks', capped.length === 3, String(capped.length));
  check('capped output still reassembles exactly',
    tv.tokenize(busy, { max: 3 }).map((x) => x.value).join('') === busy);

  // WHERE and WHO beat WHAT TO DO: the place and the agent are what a player
  // glances for, the verb is read in the sentence anyway.
  const keptKinds = capped.map((x) => x.kind);
  check('cap keeps places and agents over direction verbs',
    !keptKinds.includes('rotate') && !keptKinds.includes('push'),
    JSON.stringify(keptKinds));
  check('cap returns marks in reading order',
    capped.every((m, i) => i === 0 || busy.indexOf(m.value) >= 0));

  // A tip with fewer marks than the cap must be untouched.
  const light = 'Hold hookah and wait.';
  check('cap does not disturb a short tip',
    JSON.stringify(kinds(light)) === JSON.stringify(tv.tokenize(light, { max: 3 }).filter((x) => x.type === 'mark').map((x) => x.kind)));
}

// ── Every topic and every mark kind has an icon ─────────────────────────────
{
  // These are exactly the values topicOf() returns in coaching-engine.js. If
  // that list grows, a tip arrives here with a topic that draws nothing.
  const TOPICS = ['spike', 'utility', 'aim', 'peeking', 'positioning', 'rotation',
    'teamwork', 'economy', 'mental', 'death', 'general'];
  const missingTopic = TOPICS.filter((t) => !Array.isArray(tv.PATHS[t]) || !tv.PATHS[t].length);
  check('all 11 topics from topicOf() have a glyph', missingTopic.length === 0,
    'missing: ' + missingTopic.join(', '));

  const kindsUsed = [...new Set(tv.PATTERNS.map((p) => p.kind))];
  const missingKind = kindsUsed.filter((k) => !Array.isArray(tv.PATHS[k]) || !tv.PATHS[k].length);
  check('every pattern kind has a glyph', missingKind.length === 0,
    'missing: ' + missingKind.join(', '));

  const badPath = Object.entries(tv.PATHS)
    .filter(([, ds]) => ds.some((d) => typeof d !== 'string' || !/^[Mm]/.test(d.trim())));
  check('every path starts with a move command', badPath.length === 0,
    badPath.map(([k]) => k).join(', '));
}

// ── the icon follows its word, and agents carry a side ──────────────────────
// render() needs a DOM, which this runner has not got, so it gets the smallest
// one that satisfies what render actually calls. Worth the twenty lines: the
// order of the two child nodes and the side class are exactly what a reader
// sees, and neither is visible from tokenize() alone.
function stubDom() {
  const mk = (tag) => {
    const el = {
      tag, children: [], className: '',
      classList: { add(c) { el.className = (el.className + ' ' + c).trim(); } },
      appendChild(c) { el.children.push(c); return c; },
      setAttribute(k, v) { if (k === 'class') el.className = v; },
      set textContent(_v) { el.children.length = 0; },
      get textContent() { return ''; },
    };
    return el;
  };
  global.document = {
    createElement: mk,
    createTextNode: (t) => ({ text: t }),
    createElementNS: (_ns, tag) => mk(tag),
  };
  return mk;
}
const mk = stubDom();

function marksIn(text, opts) {
  const el = mk('div');
  tv.render(el, text, opts || {});
  return el.children.filter((c) => c.text === undefined);
}

const site = marksIn('Hold B Main tight and wait.')[0];
check('the icon comes after the word it marks, not before',
  !!site && site.children.length === 2 && site.children[0].text === 'B Main'
  && site.children[1].tag === 'svg');

const mine = marksIn('Use your dash as Jett to take the off-angle.', { agent: 'Jett' })
  .find((m) => /tv-agent/.test(m.className));
check("the player's own agent is marked as theirs", !!mine && /tv-ally/.test(mine.className));

const killer = marksIn('You died to a Sova because you peeked wide.', { agent: 'Jett' })
  .find((m) => /tv-agent/.test(m.className));
check('an agent named as killing you is marked as an opponent', !!killer && /tv-enemy/.test(killer.className));

// The important negative. There is no team composition anywhere in this app, so
// an agent mentioned with no stated relationship must stay neutral: a green
// teammate who is actually an opponent would be believed, and be wrong.
const bystander = marksIn('A Reyna is holding B Main, so wait for your team.', { agent: 'Jett' })
  .find((m) => /tv-agent/.test(m.className));
check('an agent with no known side is left uncoloured rather than guessed',
  !!bystander && !/tv-ally|tv-enemy/.test(bystander.className));

if (failures) {
  console.log('\nFAIL: ' + failures + ' tip-visuals check(s) failed');
  process.exit(1);
}
console.log('\nPASS: the lexicon marks what it should and leaves English alone');
