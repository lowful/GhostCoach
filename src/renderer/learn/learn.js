'use strict';

/**
 * The learning surface.
 *
 * Two views in one window, list and lesson, rather than two windows: a player
 * moving between "what should I do next" and "the thing itself" should not be
 * managing windows to do it.
 *
 * Everything it needs arrives in ONE call. The curriculum and the roster are
 * plain data handed over by the preload, so there is no loading state to design
 * and nothing to go wrong offline.
 */

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

/**
 * One icon per track, so the three areas are told apart at a glance rather than
 * only by their names. Drawn inline like every other glyph in the app: no file,
 * no CSP question, and it inherits currentColor.
 *   fundamentals  a foundation block
 *   laning        two opposed arrows, the lane push and pull
 *   macro         a map with a marked objective
 */
const TRACK_PATHS = {
  fundamentals: ['M4 20h16', 'M6 20v-6h5v6', 'M13 20v-9h5v9', 'M4 9l8-5 8 5'],
  laning:       ['M3 9h11', 'M11 6l3 3-3 3', 'M21 15H10', 'M13 18l-3-3 3-3'],
  macro:        ['M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z', 'M9 4v14', 'M15 6v14'],
};

function svgIcon(paths, size, cls) {
  if (!paths) return null;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  if (cls) svg.setAttribute('class', cls);
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const dashView = $('dash');
const lessonView = $('lesson');

let DATA = null;          // { tracks, lessons, progress, starters, patch, count }
let done = new Set();

// ── Progress ────────────────────────────────────────────────────────────────

/**
 * The lesson ids this player's role actually has.
 *
 * getLearn() already filters `skills` by role, and this surface was ignoring it:
 * a support saw the CS lesson in the list and a denominator of twelve, so
 * "12 of 12" was unreachable for them, and the one lesson they could never
 * complete was the one that would hurt them if they followed it. Chasing CS as
 * a support takes the farm off the ADC.
 *
 * Falls back to every lesson when the payload carries no skills, because a
 * missing field must not blank the whole curriculum.
 */
function visibleIds() {
  const skills = Array.isArray(DATA.skills) ? DATA.skills : [];
  if (!skills.length) return null;
  return new Set(skills.map((s) => s.lesson || s.id));
}

/** Lessons for this role, in curriculum order. */
function visibleLessons() {
  const ok = visibleIds();
  return ok ? DATA.lessons.filter((l) => ok.has(l.id)) : DATA.lessons;
}

const NUM_WORD = { 10: 'ten', 11: 'eleven', 12: 'twelve' };
const spell = (n) => NUM_WORD[n] || String(n);

function paintProgress() {
  const mine = visibleLessons();
  const total = mine.length;
  const n = mine.filter((l) => done.has(l.id)).length;
  $('prog-text').textContent = `${n} of ${total}`;
  $('prog-fill').style.width = total ? `${Math.round((n / total) * 100)}%` : '0%';
}

// ── The suggestion ──────────────────────────────────────────────────────────

/**
 * One skill, its target, and last game's result.
 *
 * Four states, and three of them are about NOT having a number yet. Getting
 * those right matters more than the fourth: a surface that shows a confident
 * figure it does not have is exactly what this whole feature is built to avoid.
 */
function paintFocus() {
  const a = DATA.assignment;
  const host = $('focus');

  // HIDE IT, never replaceChildren() it. This card is markup, not a container:
  // wiping it would delete f-title and every other node the next repaint writes
  // into, so one pass with no assignment would permanently blank the card for
  // the rest of the window's life. The twelve below are still fully usable, so
  // there is nothing to apologise for either.
  const lesson = a && DATA.lessons.find((l) => l.id === a.skillId);
  if (!a || !lesson) { host.hidden = true; return; }
  host.hidden = false;

  $('f-track').textContent = lesson.trackName;
  $('f-title').textContent = lesson.title;
  $('f-mistake').textContent = lesson.mistake;

  const targetEl = $('f-target');
  const targetNote = $('f-target-note');
  const lastEl = $('f-last');
  const lastNote = $('f-last-note');
  const lastBox = lastEl.parentElement;
  lastBox.classList.remove('pass', 'fail');

  // A replay skill has no number and never will. Say that rather than showing
  // a dash and letting it read as a missing value.
  if (a.klass === 'replay') {
    targetEl.className = 'a-num-value is-text';
    targetEl.textContent = 'Watch it back';
    targetNote.className = 'a-num-note';
    targetNote.textContent = 'This one cannot be measured from live data, so it is marked in the replay instead.';
  } else if (a.target === null || a.target === undefined) {
    targetEl.className = 'a-num-value is-text';
    targetEl.textContent = 'Set after a few games';
    targetNote.className = 'a-num-note';
    targetNote.textContent = 'Play a few games and this becomes your own baseline to beat.';
  } else {
    targetEl.className = 'a-num-value';
    targetEl.textContent = String(a.target);
    // WHERE THE NUMBER CAME FROM, said out loud. A rank benchmark and a
    // judgement call must never look like the same kind of thing.
    targetNote.className = 'a-num-note' + (a.sourced ? '' : ' unsourced');
    targetNote.textContent = a.metricLabel
      ? `${a.metricLabel}. ${a.note || ''}`.trim()
      : (a.note || '');
  }

  const r = DATA.lastResult;
  if (!DATA.gamesRecorded) {
    lastEl.className = 'a-num-value is-text';
    lastEl.textContent = 'No game recorded yet';
    lastNote.textContent = 'Finish a game with Occlara open and it gets checked here.';
  } else if (!r || r.measured === null || r.measured === undefined) {
    lastEl.className = 'a-num-value is-text';
    lastEl.textContent = 'Not measured';
    lastNote.textContent = 'Last game did not carry the data for this one.';
  } else {
    lastEl.className = 'a-num-value';
    lastEl.textContent = String(r.measured);
    if (r.verdict === 'pass' || r.verdict === 'fail') {
      lastBox.classList.add(r.verdict);
      const word = r.verdict === 'pass' ? 'Better than your average' : 'Below your average';
      lastNote.textContent = r.baseline !== null && r.baseline !== undefined
        ? `${word} of ${r.baseline}.` : word + '.';
    } else {
      lastNote.textContent = 'Still learning your baseline.';
    }
  }

  // Say why this one. The coach chose it, so the choice has to be defensible
  // on screen, not just in the ranking function.
  const why = $('f-why');
  if (a.klass === 'replay') {
    why.textContent = 'Assigned because it cannot be measured, so the only way to learn it is to watch the moment back.';
  } else if (!DATA.gamesRecorded) {
    why.textContent = 'Start here. Once a few games are recorded the coach picks whichever skill you are furthest behind on.';
  } else if (r && r.verdict === 'fail') {
    why.textContent = 'Assigned because it is the furthest below your own recent average. It stays here until it sticks.';
  } else if (r && r.verdict === 'pass') {
    why.textContent = 'You beat your average last game. Hold it one more, then the coach moves you on.';
  } else {
    why.textContent = 'Still building a baseline from your recent games before it can judge this one.';
  }

  $('f-open').onclick = () => openLesson(a.skillId, 'dash');
}

// ── The list ────────────────────────────────────────────────────────────────

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13'); svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'l-chev');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M9 6l6 6-6 6');
  svg.appendChild(p);
  return svg;
}

function tickMark() {
  const wrap = document.createElement('span');
  wrap.className = 'tick';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '11'); svg.setAttribute('height', '11');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3.2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M4 12.5l5 5L20 6.5');
  svg.appendChild(p);
  wrap.appendChild(svg);
  return wrap;
}

function paintTracks() {
  const total = visibleLessons().length;
  $('intro').textContent =
    `${spell(total).replace(/^./, (c) => c.toUpperCase())} habits that decide games. `
    + `Work them in any order and tick each one off when it sticks.`;

  const host = $('tracks');
  host.replaceChildren();

  let rowIndex = 0;
  const ok = visibleIds();
  for (const track of DATA.tracks) {
    const mine = ok ? track.lessons.filter((l) => ok.has(l.id)) : track.lessons;
    if (!mine.length) continue;      // a whole track excluded by role shows nothing, not an empty heading

    const sec = document.createElement('section');
    sec.className = 'track';

    const head = document.createElement('div');
    head.className = 'track-head';
    const ico = svgIcon(TRACK_PATHS[track.id], 15, 'track-ico');
    if (ico) head.appendChild(ico);
    const h = document.createElement('h3');
    h.textContent = track.name;
    const count = document.createElement('span');
    count.className = 'track-count';
    const tDone = mine.filter((l) => done.has(l.id)).length;
    count.textContent = `${tDone}/${mine.length}`;
    head.append(h, count);

    const blurb = document.createElement('p');
    blurb.className = 'track-blurb';
    blurb.textContent = track.blurb;

    sec.append(head, blurb);

    for (const l of mine) {
      // A ROW IS TWO CONTROLS, not one. The tick marks a skill done without
      // opening it, which is the whole point of a dashboard you work through
      // over weeks; the title opens the lesson. Nesting a button inside a
      // button is invalid HTML and the inner one stops receiving clicks, so the
      // row is a div and each half is its own button.
      const row = document.createElement('div');
      row.className = 'lesson-row' + (done.has(l.id) ? ' done' : '');

      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'row-tick';
      tick.setAttribute('aria-pressed', done.has(l.id) ? 'true' : 'false');
      tick.setAttribute('aria-label', (done.has(l.id) ? 'Mark not done: ' : 'Mark done: ') + l.title);
      tick.title = done.has(l.id) ? 'Mark not done' : 'Mark done';
      tick.appendChild(tickMark());
      tick.addEventListener('click', (e) => { e.stopPropagation(); toggleDone(l.id); });

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'row-open';
      const name = document.createElement('span');
      name.className = 'l-name';
      name.textContent = l.title;
      open.append(name, chevron());
      open.addEventListener('click', () => openLesson(l.id, 'dash'));

      row.append(tick, open);
      // The list assembles top to bottom. 40ms apart is the point where a
      // stagger reads as one gesture instead of a queue, and the whole thing is
      // finished well inside half a second.
      row.style.animationDelay = `${Math.min(rowIndex++, 12) * 40}ms`;
      sec.appendChild(row);
    }
    host.appendChild(sec);
  }

  paintProgress();
}

function paintStarters() {
  const host = $('starters');
  host.replaceChildren();
  const lanes = DATA.starters || {};
  $('champ-hint').textContent = DATA.role
    ? `Champions worth learning first as a ${DATA.role}, and what each one teaches. Patch ${DATA.patch}.`
    : `Champions worth learning first, and the reason each one teaches something. Patch ${DATA.patch}.`;

  // Never a blank panel: if the roster failed to load, say so and say what to do.
  if (!Object.keys(lanes).length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Champion data is not available in this build. Run npm run sync:lol to add it.';
    host.appendChild(p);
    return;
  }

  for (const [lane, picks] of Object.entries(lanes)) {
    const wrap = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'lane-name';
    name.textContent = lane;
    const list = document.createElement('div');
    list.className = 'picks';

    for (const p of picks) {
      const row = document.createElement('div');
      row.className = 'pick';
      if (p.icon) {
        const img = document.createElement('img');
        // Riot licenses Data Dragon art for third-party use, so this is a real
        // portrait rather than the role glyph the Rivals side has to use.
        img.src = `../../../assets/${p.icon}`;
        img.width = 34; img.height = 34;
        img.alt = '';
        // A missing icon must not leave a broken image: the name still carries
        // the information on its own.
        img.addEventListener('error', () => img.remove());
        row.appendChild(img);
      }
      const text = document.createElement('div');
      text.className = 'pick-text';
      const n = document.createElement('div');
      n.className = 'pick-name';
      n.textContent = p.name;
      const why = document.createElement('div');
      why.className = 'pick-why';
      why.textContent = p.why;
      text.append(n, why);
      row.appendChild(text);
      list.appendChild(row);
    }
    wrap.append(name, list);
    host.appendChild(wrap);
  }
}

// ── A lesson ────────────────────────────────────────────────────────────────

function openLesson(id, from) {
  const l = DATA.lessons.find((x) => x.id === id);
  if (!l) return;
  $('back-label').textContent = 'Back to Learn';

  $('l-track').textContent = l.trackName;
  $('l-title').textContent = l.title;
  $('l-mistake').textContent = l.mistake;

  const body = $('l-body');
  body.replaceChildren();
  for (const para of l.body) {
    const p = document.createElement('p');
    p.textContent = para;
    body.appendChild(p);
  }

  const practice = $('l-practice');
  practice.replaceChildren();
  for (const q of l.practice) practice.appendChild(question(q));

  const btn = $('l-done');
  const isDone = done.has(l.id);
  btn.textContent = isDone ? 'Completed' : 'Mark complete';
  btn.classList.toggle('is-done', isDone);
  btn.onclick = () => toggleDone(l.id);

  dashView.hidden = true;
  lessonView.hidden = false;
  lessonView.scrollTop = 0;
  // Restart the entrance rather than letting it play only the first time.
  lessonView.classList.remove('view-in');
  void lessonView.offsetWidth;
  lessonView.classList.add('view-in');
}

function question(q) {
  const wrap = document.createElement('div');
  wrap.className = 'q';

  const text = document.createElement('div');
  text.className = 'q-text';
  text.textContent = q.q;

  const opts = document.createElement('div');
  opts.className = 'opts';

  const why = document.createElement('div');
  why.className = 'why';
  why.hidden = true;
  why.textContent = q.why;

  q.options.forEach((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.textContent = label;
    b.addEventListener('click', () => {
      // Answering locks the question. Letting someone try again until it goes
      // green turns a check into a clicking exercise.
      const buttons = [...opts.children];
      buttons.forEach((x, n) => {
        x.disabled = true;
        if (n === q.answer) { x.classList.add('right'); x.appendChild(mark('Correct')); }
        else if (n === i) { x.classList.add('wrong'); x.appendChild(mark('Not this')); }
      });
      // The explanation shows whether they were right or wrong, because being
      // right for the wrong reason is the thing a quiz cannot otherwise catch.
      why.hidden = false;
    });
    opts.appendChild(b);
  });

  wrap.append(text, opts, why);
  return wrap;
}

function mark(word) {
  const s = document.createElement('span');
  s.className = 'opt-mark';
  s.textContent = word;
  return s;
}

async function toggleDone(id) {
  const next = !done.has(id);
  if (next) done.add(id); else done.delete(id);

  const btn = $('l-done');
  btn.textContent = next ? 'Completed' : 'Mark complete';
  btn.classList.toggle('is-done', next);
  paintProgress();

  try {
    const res = await window.occlara.setProgress(id, next);
    if (res && Array.isArray(res.progress)) done = new Set(res.progress);
  } catch { /* the local state already moved; a failed write retries next time */ }
  paintDash();
}

function show(view) {
  dashView.hidden = view !== 'dash';
  lessonView.hidden = view !== 'lesson';
  const el = view === 'dash' ? dashView : lessonView;
  // Restart the entrance rather than letting it play only the first time.
  el.classList.remove('view-in');
  void el.offsetWidth;
  el.classList.add('view-in');
  el.scrollTop = 0;
}

// ── Who is learning ─────────────────────────────────────────────────────────

// Five bands, not eight ranks, matching lol-targets.js. The data does not
// support eight-way granularity and the alternative is inventing seven numbers
// to sit between the two that are real.
const BANDS = [
  [1, 'Iron / Bronze'],
  [2, 'Silver'],
  [3, 'Gold'],
  [4, 'Plat / Emerald'],
  [5, 'Diamond+'],
];
const ROLES = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];

/** One segmented control. Plain buttons, no dropdown dependency. */
function seg(host, options, current, onPick) {
  host.replaceChildren();
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (String(value) === String(current) ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => onPick(value));
    host.appendChild(b);
  }
}

/**
 * Rank band and role.
 *
 * Editable HERE rather than in Settings because they are not preferences: the
 * role decides which of the twelve skills apply at all, and the band decides
 * every sourced target. Someone reading a target wants to correct the rank it
 * was computed from without leaving the page.
 */
function paintProfile() {
  seg($('band-seg'), BANDS, DATA.band, (v) => saveProfile(v, DATA.role));
  // '' is a real, chosen value meaning "not saying", and it shows every skill.
  // Guessing a role and hiding a lesson is worse than showing one that does not
  // apply, so the opt out is a visible option rather than an empty state.
  seg($('role-seg'), ROLES.map((r) => [r, r]).concat([['', 'Any']]), DATA.role || '', (v) => saveProfile(DATA.band, v));

  const bandName = (BANDS.find((b) => b[0] === DATA.band) || [0, 'Silver'])[1];
  $('prof-note').textContent = DATA.role
    ? `Targets are set for ${bandName} as a ${DATA.role}.`
    : `Targets are set for ${bandName}. Pick a role and the skills that do not apply to it drop out.`;
}

async function saveProfile(band, role) {
  try {
    const d = await window.occlara.setProfile(Number(band), role);
    if (d) { DATA = d; done = new Set(Array.isArray(d.progress) ? d.progress : []); }
  } catch { /* the store is the source of truth; a failed write just does nothing */ }
  paintDash();
}

/** Repaint everything and show it. One view, so there is nothing to choose. */
function paintDash() {
  paintProfile();
  paintFocus();
  paintTracks();
  paintStarters();
}
function showDash() { paintDash(); show('dash'); }

// ── Wiring ──────────────────────────────────────────────────────────────────

$('back').addEventListener('click', showDash);
$('close').addEventListener('click', () => window.occlara.close());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Escape steps back one level rather than closing outright, so it cannot
  // throw away a lesson someone is halfway through reading.
  if (!lessonView.hidden) showDash();
  else window.occlara.close();
});

window.occlara.getLearn().then((d) => {
  DATA = d;
  done = new Set(Array.isArray(d.progress) ? d.progress : []);
  showDash();
  console.log('[learn] ready');
}).catch((e) => {
  const host = $('tracks');
  host.replaceChildren();
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = 'Could not load the curriculum. Close and reopen this window.';
  host.appendChild(p);
  console.error('[learn] load failed', e);
});
