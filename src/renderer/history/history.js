'use strict';

const listEl  = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');

const SRC_LABEL = { ai: 'Coach', library: 'Tip', system: 'GhostCoach' };

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

let ratings = {};   // text -> 'good' | 'bad' (from the state snapshot)

function rowFor(tip) {
  const row = document.createElement('div');
  row.className = `row ${tip.source || 'system'}`;
  const col = document.createElement('div');
  col.className = 'col';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const src = document.createElement('span');
  src.className = 'src';
  src.textContent = SRC_LABEL[tip.source] || 'GhostCoach';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(tip.time);
  meta.append(src, time);

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = tip.text;

  col.append(meta, text);
  row.append(col);

  // Rate coaching tips (not system notices): hover shows check / X.
  if (tip.source === 'ai' || tip.source === 'library') {
    const rated = ratings[tip.text];
    if (rated) {
      row.classList.add(`rated-${rated}`);
      const badge = document.createElement('span');
      badge.className = `rate-badge ${rated}`;
      badge.textContent = rated === 'good' ? '✓ helpful' : '✗ not for me';
      meta.append(badge);
    } else {
      const actions = document.createElement('div');
      actions.className = 'rate';
      const good = document.createElement('button');
      good.className = 'rate-btn good';
      good.title = 'Good tip';
      good.textContent = '✓';
      const bad = document.createElement('button');
      bad.className = 'rate-btn bad';
      bad.title = 'Bad tip, show fewer like this';
      bad.textContent = '✗';
      const rate = (rating) => {
        ratings[tip.text] = rating;               // instant local feedback
        window.ghost.rateTip({ text: tip.text, source: tip.source, rating });
      };
      good.addEventListener('click', () => rate('good'));
      bad.addEventListener('click', () => rate('bad'));
      actions.append(good, bad);
      row.append(actions);
    }
  }
  return row;
}

const mixAiEl   = document.getElementById('mix-ai');
const mixLibEl  = document.getElementById('mix-lib');
const mixFillEl = document.getElementById('mix-fill');

function renderMix(mix) {
  const ai = (mix && mix.ai) || 0;
  const lib = (mix && mix.library) || 0;
  const total = ai + lib;
  const aiPct = total ? Math.round((ai / total) * 100) : 0;
  mixAiEl.textContent  = `${aiPct}%`;
  mixLibEl.textContent = `${total ? 100 - aiPct : 0}%`;
  mixFillEl.style.width = `${aiPct}%`;
}

// Full re-render from the state snapshot.
function render(state) {
  const list = (state && Array.isArray(state.tips)) ? state.tips : [];
  if (state && state.tipRatings) ratings = { ...state.tipRatings, ...ratings };
  countEl.textContent = String(list.length);
  renderMix(state && state.tipMix);
  listEl.querySelectorAll('.row').forEach((r) => r.remove());
  emptyEl.hidden = list.length > 0;
  for (const tip of list) listEl.append(rowFor(tip));
}

window.ghost.getState().then((s) => render(s)).catch(() => {});
window.ghost.onState((s) => { if (s) render(s); });

document.getElementById('close').addEventListener('click', () => window.close());
console.log('[history] ready');
