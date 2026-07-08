'use strict';

const tipsEl   = document.getElementById('tips');
const pillEl   = document.getElementById('status-pill');
const dotEl    = document.getElementById('status-dot');
const statusEl = document.getElementById('status-text');
const reviewEl = document.getElementById('review');

const TIP_TTL = 11000;     // auto-dismiss after 11s
const MAX_VISIBLE = 4;

const STATUS_LABEL = { idle: 'Idle', coaching: 'Coaching', paused: 'Paused', stopped: 'Stopped' };

function sourceLabel(src) {
  if (src === 'ai') return 'Coach';
  if (src === 'library') return 'Tip';
  return 'GhostCoach';
}

function formatTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

function addTip(tip) {
  if (!tip || !tip.text) return;

  const card = document.createElement('div');
  card.className = `tip-card ${tip.source || 'system'}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<span class="src-dot"></span>';
  meta.append(sourceLabel(tip.source));
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = formatTime(tip.time || Date.now());
  meta.append(when);
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = tip.text;
  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.style.animationDuration = TIP_TTL + 'ms';
  card.append(meta, text, progress);

  tipsEl.prepend(card);
  while (tipsEl.children.length > MAX_VISIBLE) dismiss(tipsEl.lastElementChild);

  const timer = setTimeout(() => dismiss(card), TIP_TTL);
  card._timer = timer;
}

function dismiss(card) {
  if (!card || card.classList.contains('out')) return;
  clearTimeout(card._timer);
  card.classList.add('out');
  setTimeout(() => card.remove(), 240);
}

function setStatus(status) {
  if (!status) return;
  dotEl.className = `dot ${status}`;
  statusEl.textContent = STATUS_LABEL[status] || 'Idle';
  // Hide the ambient status pill during active coaching so nothing sits in the
  // bottom-left mid-game; only surface it for the transient paused/stopped states.
  pillEl.classList.toggle('show', status === 'paused' || status === 'stopped');
}

function setTipPosition(pos) {
  if (pos) tipsEl.dataset.pos = pos;
}

// Scale the tip stack in ratio, anchored to its corner so it grows inward and
// pairs with every position (top/bottom, left/right). 1 = normal size.
const SCALE_ORIGIN = {
  'top-right':    'top right',
  'top-left':     'top left',
  'bottom-right': 'bottom right',
  'bottom-left':  'bottom left',
};
function setTipScale(scale) {
  const s = Number(scale);
  const val = s > 0 && isFinite(s) ? Math.min(1.5, Math.max(0.6, s)) : 1;
  tipsEl.style.transform = val === 1 ? '' : `scale(${val})`;
  tipsEl.style.transformOrigin = SCALE_ORIGIN[tipsEl.dataset.pos] || 'top right';
}

// ── Match review ─────────────────────────────────────────────────────────────
function showReview(data) {
  if (!data || !data.review) return;
  reviewEl.hidden = false;
  reviewEl.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'review-card';
  const h = document.createElement('h3');
  h.innerHTML = '<span class="src-dot"></span>';
  h.append('Match Review');
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = data.review;
  card.append(h, body);
  reviewEl.append(card);

  setTimeout(() => {
    card.classList.add('out');
    setTimeout(() => { reviewEl.hidden = true; reviewEl.innerHTML = ''; }, 300);
  }, 22000);
}

// ── Subscriptions ────────────────────────────────────────────────────────────
window.ghost.onTip(addTip);
window.ghost.onStatus(({ status }) => setStatus(status));
window.ghost.onState((s) => {
  if (s) { setStatus(s.status); setTipPosition(s.tipPosition); setTipScale(s.tipScale); }
});
window.ghost.onMatchReview(showReview);
window.ghost.onVisibility(({ visible }) => {
  document.body.classList.toggle('hidden-overlay', !visible);
});

console.log('[overlay] ready');
