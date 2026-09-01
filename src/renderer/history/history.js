'use strict';

const listEl  = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');

const SRC_LABEL = { ai: 'Coach', library: 'Tip', system: 'Occlara' };

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

let ratings = {};   // text -> 'good' | 'bad' (from the state snapshot)

function rowFor(tip) {
  const row = document.createElement('div');
  row.className = `row ${tip.source || 'system'}${tip.death ? ' death' : ''}`;
  const col = document.createElement('div');
  col.className = 'col';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const src = document.createElement('span');
  src.className = 'src';
  src.textContent = tip.death ? 'Death Review' : (SRC_LABEL[tip.source] || 'Occlara');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(tip.time);
  meta.append(src, time);

  const text = document.createElement('div');
  text.className = 'text';
  if (window.tipVisuals) window.tipVisuals.render(text, tip.text, { topic: tip.topic });
  else text.textContent = tip.text;

  col.append(meta, text);
  row.append(col);

  // Rate coaching tips (not system notices): hover shows check / X.
  if (tip.source === 'ai' || tip.source === 'library') {
    const rated = ratings[tip.text];
    if (rated) {
      row.classList.add(`rated-${rated}`);
      const badge = document.createElement('span');
      badge.className = `rate-badge ${rated}`;
      badge.textContent = rated === 'good' ? 'Helpful' : 'Not for me';
      meta.append(badge);
    } else {
      const actions = document.createElement('div');
      actions.className = 'rate';
      const good = document.createElement('button');
      good.className = 'rate-btn good';
      good.title = 'Good tip';
      good.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 7"/></svg>';
      const bad = document.createElement('button');
      bad.className = 'rate-btn bad';
      bad.title = 'Bad tip, show fewer like this';
      bad.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
      good.addEventListener('click', () => {
        ratings[tip.text] = 'good';               // instant local feedback
        window.occlara.rateTip({ text: tip.text, source: tip.source, rating: 'good' });
      });
      // X asks WHY: the written reason teaches the AI what actually went
      // wrong, and the same tip only gets blocked after 3 separate X ratings.
      bad.addEventListener('click', () => openFeedbackForm(row, col, tip, actions));
      actions.append(good, bad);
      row.append(actions);
    }
  }
  return row;
}

// ── X-rating feedback form (inline, one open at a time) ──────────────────────
let fbOpen = false;   // pause live re-renders while the player is typing

function openFeedbackForm(row, col, tip, actions) {
  if (fbOpen) return;
  fbOpen = true;
  actions.hidden = true;

  const fb = document.createElement('div');
  fb.className = 'fb';
  const label = document.createElement('span');
  label.className = 'fb-label';
  label.textContent = 'What was wrong with this tip?';
  const rowEl = document.createElement('div');
  rowEl.className = 'fb-row';
  const input = document.createElement('input');
  input.className = 'fb-input';
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = 'e.g. I had no smokes left, this was impossible';
  const send = document.createElement('button');
  send.className = 'fb-btn send';
  send.textContent = 'Send';
  send.disabled = true;
  const cancel = document.createElement('button');
  cancel.className = 'fb-btn';
  cancel.textContent = 'Cancel';

  input.addEventListener('input', () => { send.disabled = !input.value.trim(); });
  const close = () => { fbOpen = false; fb.remove(); actions.hidden = false; };
  cancel.addEventListener('click', close);
  const submit = () => {
    const reason = input.value.trim();
    if (!reason) return;
    ratings[tip.text] = 'bad';
    window.occlara.rateTip({ text: tip.text, source: tip.source, rating: 'bad', reason });
    fbOpen = false;
    fb.remove();
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); });

  rowEl.append(input, send, cancel);
  fb.append(label, rowEl);
  col.append(fb);
  setTimeout(() => input.focus(), 30);
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

// ── Past sessions ─────────────────────────────────────────────────────────────
// The picker swaps the list to an archived session (read-only snapshot); the
// "Current session" option returns to the live view with real-time updates.
const pickerEl = document.getElementById('session-picker');
let viewingFile = '';   // '' = live current session

function sessionLabel(s) {
  const d = new Date(s.endedAt || 0);
  const when = d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
               d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${when}${s.agent ? ' · ' + s.agent : ''} · ${s.tipCount} tips`;
}

async function populateSessions() {
  try {
    const sessions = await window.occlara.listSessions();
    const current = pickerEl.value;
    while (pickerEl.options.length > 1) pickerEl.remove(1);
    for (const s of sessions || []) {
      const opt = document.createElement('option');
      opt.value = s.file;
      opt.textContent = sessionLabel(s);
      pickerEl.append(opt);
    }
    pickerEl.value = current && [...pickerEl.options].some((o) => o.value === current) ? current : viewingFile;
  } catch {}
}

/*
 * Which decision-log session belongs to the archive file on screen.
 *
 * Both are stamped with the moment the session ended and the moment it began,
 * so they never share an id and cannot be matched by name. The log session
 * that STARTED most recently before this archive ENDED is the same sitting,
 * and a sitting is never shorter than a second or longer than a few hours,
 * which is what the window below checks.
 */
const SAME_SITTING_MS = 6 * 60 * 60 * 1000;

async function logIdFor(file) {
  // The live session, which is always the newest log if one is running.
  if (!file) return null;

  const endedAt = Date.parse(String(file).replace(/^session-/, '').replace(/\.json$/, '')
    .replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z'));
  if (!Number.isFinite(endedAt)) return null;

  const logs = await window.occlara.aiLogSessions().catch(() => []);
  let best = null;
  for (const s of logs || []) {
    const startedAt = Number(s.at);
    if (!Number.isFinite(startedAt)) continue;
    // Started before this archive ended, and within one sitting of it.
    if (startedAt > endedAt) continue;
    if (endedAt - startedAt > SAME_SITTING_MS) continue;
    if (!best || startedAt > best.at) best = { id: s.id, at: startedAt };
  }
  return best ? best.id : null;
}

const aiLogBtn = document.getElementById('open-ailog');
aiLogBtn.addEventListener('click', async () => {
  const id = await logIdFor(viewingFile);

  /*
   * A session with no frame log says so rather than opening someone else's.
   * The archive keeps far more sessions than the frame log does, so an older
   * match has its tips and none of its frames.
   */
  if (viewingFile && !id) {
    aiLogBtn.classList.add('no-log');
    aiLogBtn.title = 'No decision log kept for this session. Only the last few sessions keep their frames.';
    setTimeout(() => {
      aiLogBtn.classList.remove('no-log');
      aiLogBtn.title = 'Open the AI decision log for this session';
    }, 2200);
    return;
  }

  window.occlara.openAiLog(id || undefined);
});

pickerEl.addEventListener('mousedown', populateSessions);
pickerEl.addEventListener('change', async () => {
  viewingFile = pickerEl.value;
  if (!viewingFile) {
    window.occlara.getState().then((s) => render(s)).catch(() => {});
    return;
  }
  const session = await window.occlara.getSession(viewingFile).catch(() => null);
  if (!session) { viewingFile = ''; pickerEl.value = ''; return; }
  const tips = session.tips || [];
  const mix = session.tipMix || {
    ai:      tips.filter((t) => t.source === 'ai').length,
    library: tips.filter((t) => t.source === 'library').length,
  };
  render({ tips, tipMix: mix, tipRatings: {} });
});

window.occlara.getState().then((s) => render(s)).catch(() => {});
window.occlara.onState((s) => { if (s && !viewingFile && !fbOpen) render(s); });   // never yank the form mid-typing
populateSessions();

document.getElementById('close').addEventListener('click', () => window.close());
console.log('[history] ready');
