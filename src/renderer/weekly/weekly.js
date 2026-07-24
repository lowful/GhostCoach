'use strict';

/**
 * Weekly report popup. Renders whatever the main process could honestly
 * assemble: stat movement against last week's baseline, the four category
 * ratings, and the coach's own notes on the week. Sections with nothing behind
 * them stay hidden rather than showing an empty shell.
 */

const $ = (id) => document.getElementById(id);
const ARROW = { up: '▲', down: '▼', flat: '' };

/** Text only, never innerHTML: report content includes AI-written strings. */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function card(key, value) {
  const c = el('div', 'top-card');
  c.appendChild(el('div', 'k', key));
  c.appendChild(el('div', 'v', value));
  return c;
}

function renderTopline(r) {
  const box = $('topline');
  box.textContent = '';
  if (r.rank) box.appendChild(card('Rank', r.rank));
  box.appendChild(card('Sessions coached', r.sessions));
  if (r.avgOverall != null) box.appendChild(card('Average score', r.avgOverall));
  else if (r.matchesTracked) box.appendChild(card('Matches tracked', r.matchesTracked));
}

function renderDeltas(r) {
  const box = $('deltas');
  box.textContent = '';
  for (const d of r.deltas || []) {
    const row = el('div', 'delta ' + d.direction);
    row.appendChild(el('span', 'label', d.label));
    row.appendChild(el('span', 'value', d.value));
    // Only show a chip when something actually moved, so a flat week reads as
    // steady rather than as a wall of zeroes.
    if (d.change) row.appendChild(el('span', 'chg', ARROW[d.direction] + ' ' + d.change));
    box.appendChild(row);
  }
  if (!box.children.length) {
    box.appendChild(el('p', 'note', 'Connect your Riot ID in Settings to track how your stats move week to week.'));
  }
}

function renderCategories(r) {
  const box = $('cats');
  box.textContent = '';
  const labels = { impact: 'Impact', positioning: 'Positioning', utility: 'Utility', aim: 'Aim' };
  let shown = 0;
  for (const [key, label] of Object.entries(labels)) {
    const c = r.categories && r.categories[key];
    if (!c || c.avg == null) continue;
    shown++;
    const wrap = el('div', 'cat'
      + (r.best  && r.best.key  === key ? ' best'  : '')
      + (r.worst && r.worst.key === key ? ' worst' : ''));
    const top = el('div', 'cat-top');
    top.appendChild(el('span', 'name', label));
    const score = el('span', 'score', String(c.avg));
    if (ARROW[c.direction]) score.appendChild(el('span', 'arrow ' + c.direction, ' ' + ARROW[c.direction]));
    top.appendChild(score);
    wrap.appendChild(top);
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, c.avg)) + '%';
    bar.appendChild(fill);
    wrap.appendChild(bar);
    box.appendChild(wrap);
  }
  $('cat-section').hidden = shown === 0;
}

function renderNotes(listId, sectionId, items) {
  const ul = $(listId);
  ul.textContent = '';
  for (const t of items || []) ul.appendChild(el('li', null, t));
  $(sectionId).hidden = !(items && items.length);
}

function renderEmpty(r) {
  $('empty').hidden = false;
  const msg = r.reason === 'not-connected'
    ? 'Connect your Riot ID in Settings and run a coaching session or two. Next week you will get a full breakdown of what improved and what to work on.'
    : 'Play a few matches with coaching on and your first report will be ready. It gets more useful every week.';
  $('empty-msg').textContent = msg;
  $('subtitle').textContent = 'Nothing to report yet';
}

function render(r) {
  $('loading').hidden = true;
  if (!r || !r.hasData) { renderEmpty(r || {}); return; }

  $('content').hidden = false;
  $('subtitle').textContent = r.riotId || 'Last 7 days';
  $('first-week').hidden = !r.firstWeek;

  renderTopline(r);
  renderDeltas(r);
  renderCategories(r);
  renderNotes('well', 'well-section', r.doingWell);
  renderNotes('fix',  'fix-section',  r.toImprove);
}

$('close').addEventListener('click', () => window.ghost.close());
$('stats').addEventListener('click', () => { window.ghost.openStats(); window.ghost.close(); });
$('ask').addEventListener('click',   () => { window.ghost.openChat();  window.ghost.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.ghost.close(); });

console.log('[weekly] ready');

window.ghost.getReport()
  .then(render)
  .catch((err) => {
    $('loading').hidden = true;
    renderEmpty({});
    console.error('[weekly] could not load the report:', err);
  });
