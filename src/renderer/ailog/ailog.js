'use strict';

/**
 * AI decision-log viewer. Scrubs through this session's analyzed frames, each
 * paired with the STATE the coach parsed (its notes) and the tip. Text only,
 * never innerHTML: STATE and tips are AI-written strings.
 */
const $ = (id) => document.getElementById(id);
let records = [];
let idx = 0;

// The STATE fields worth surfacing, in a sensible reading order, with the
// location + alive reads flagged since those are the usual culprits.
const FIELDS = [
  ['map', 'map'], ['side', 'side'], ['gameMode', 'mode'], ['roundNumber', 'round'],
  ['clock', 'clock'], ['phase', 'phase'], ['playerAlive', 'alive', 'alive'],
  ['playerSpot', 'location', 'key'], ['teamScore', 'your score'], ['enemyScore', 'their score'],
  ['teammatesAlive', 'mates alive'], ['enemiesAlive', 'foes alive'],
  ['playerWeapon', 'weapon'], ['playerCredits', 'credits'],
  ['enemySpot', 'enemy spot'], ['teamRead', 'team read'], ['playerNote', 'note'],
];

function fmtTime(at, first) {
  if (!at) return '';
  const secs = first ? Math.round((at - first) / 1000) : 0;
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `+${mm}:${ss}`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function render() {
  const r = records[idx];
  if (!r) return;
  $('frame').src = r.frameData || '';
  $('pos').textContent = `${idx + 1} / ${records.length}`;
  $('time').textContent = fmtTime(r.at, records[0] && records[0].at);
  $('slider').value = String(idx);

  // Tip shown after the gates (and the raw AI tip when it differs / was dropped).
  const shown = r.shown && r.shown.text;
  const shownEl = $('shown');
  shownEl.textContent = shown || 'No tip shown this frame (SKIP or filtered).';
  shownEl.classList.toggle('none', !shown);
  const raw = String(r.aiTip || '').trim();
  const showRaw = raw && raw.toUpperCase() !== 'SKIP' && raw !== shown;
  $('raw-block').hidden = !showRaw;
  if (showRaw) $('raw').textContent = raw;

  // STATE table.
  const box = $('state');
  box.textContent = '';
  const st = r.state || {};
  let any = false;
  for (const [key, label, flag] of FIELDS) {
    let v = st[key];
    if (v == null || v === '') continue;
    any = true;
    if (key === 'playerAlive') v = v ? 'yes' : 'DEAD / spectating';
    const row = el('div', 'srow' + (flag === 'key' ? ' key' : '') + (key === 'playerAlive' && st[key] === false ? ' dead' : ''));
    row.appendChild(el('span', 'k', label));
    row.appendChild(el('span', 'v', v));
    box.appendChild(row);
  }
  if (!any) box.appendChild(el('div', 'srow', 'The AI reported no readable HUD state for this frame.'));
}

function go(to) { idx = Math.max(0, Math.min(records.length - 1, to)); render(); }

$('close').addEventListener('click', () => window.ghost.close());
$('prev').addEventListener('click', () => go(idx - 1));
$('next').addEventListener('click', () => go(idx + 1));
$('slider').addEventListener('input', (e) => go(Number(e.target.value)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.ghost.close();
  else if (e.key === 'ArrowLeft') go(idx - 1);
  else if (e.key === 'ArrowRight') go(idx + 1);
});

window.ghost.getLog().then((log) => {
  records = (log && Array.isArray(log.records)) ? log.records : [];
  if (!records.length) {
    $('empty').hidden = false;
    $('empty').textContent = 'No AI log yet. Start a coaching session (with the AI log enabled in Settings) and the frames the coach reads will show up here to review.';
    return;
  }
  $('main').hidden = false;
  $('slider').max = String(records.length - 1);
  $('subtitle').textContent = `${records.length} frames from your latest session`;
  // Jump to the most recent frame first, that is usually what you want to review.
  go(records.length - 1);
}).catch((err) => {
  $('empty').hidden = false;
  $('empty').textContent = 'Could not load the AI log.';
  console.error('[ailog] load failed', err);
});

console.log('[ailog] ready');
