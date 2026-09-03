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

const listView = $('list');
const lessonView = $('lesson');

let DATA = null;          // { tracks, lessons, progress, starters, patch, count }
let done = new Set();

// ── Progress ────────────────────────────────────────────────────────────────

function paintProgress() {
  const total = DATA.lessons.length;
  const n = DATA.lessons.filter((l) => done.has(l.id)).length;
  $('prog-text').textContent = `${n} of ${total}`;
  $('prog-fill').style.width = total ? `${Math.round((n / total) * 100)}%` : '0%';
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

function paintList() {
  $('intro').textContent =
    `Twelve short lessons on the habits that decide games, each with a question to check it landed. `
    + `Champion data is patch ${DATA.patch}.`;

  const host = $('tracks');
  host.replaceChildren();

  let rowIndex = 0;
  for (const track of DATA.tracks) {
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
    const tDone = track.lessons.filter((l) => done.has(l.id)).length;
    count.textContent = `${tDone}/${track.lessons.length}`;
    head.append(h, count);

    const blurb = document.createElement('p');
    blurb.className = 'track-blurb';
    blurb.textContent = track.blurb;

    sec.append(head, blurb);

    for (const l of track.lessons) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'lesson-row' + (done.has(l.id) ? ' done' : '');
      const name = document.createElement('span');
      name.className = 'l-name';
      name.textContent = l.title;
      row.append(tickMark(), name, chevron());
      row.addEventListener('click', () => openLesson(l.id));
      // The list assembles top to bottom. 40ms apart is the point where a
      // stagger reads as one gesture instead of a queue, and the whole thing is
      // finished well inside half a second.
      row.style.animationDelay = `${Math.min(rowIndex++, 12) * 40}ms`;
      sec.appendChild(row);
    }
    host.appendChild(sec);
  }

  paintStarters();
  paintProgress();
}

function paintStarters() {
  const host = $('starters');
  host.replaceChildren();
  const lanes = DATA.starters || {};

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

function openLesson(id) {
  const l = DATA.lessons.find((x) => x.id === id);
  if (!l) return;

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

  listView.hidden = true;
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
  paintList();
}

function showList() {
  lessonView.hidden = true;
  listView.hidden = false;
  listView.classList.remove('view-in');
  void listView.offsetWidth;
  listView.classList.add('view-in');
  paintList();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

$('back').addEventListener('click', showList);
$('close').addEventListener('click', () => window.occlara.close());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Escape steps back one level rather than closing outright, so it cannot
  // throw away a lesson someone is halfway through reading.
  if (!lessonView.hidden) showList();
  else window.occlara.close();
});

window.occlara.getLearn().then((d) => {
  DATA = d;
  done = new Set(Array.isArray(d.progress) ? d.progress : []);
  paintList();
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
