'use strict';

const tipsEl   = document.getElementById('tips');
const reviewEl = document.getElementById('review');

const TIP_TTL = 11000;     // auto-dismiss after 11s
const MAX_VISIBLE = 4;

function sourceLabel(src) {
  if (src === 'ai') return 'Coach';
  if (src === 'library') return 'Tip';
  return 'GhostCoach';
}

function formatTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

let tipsVisible = true;   // "Show tips" setting: hidden tips are still recorded

function setShowTips(v) {
  tipsVisible = v !== false;
  tipsEl.style.display = tipsVisible ? '' : 'none';
}

function addTip(tip) {
  if (!tip || !tip.text) return;
  if (!tipsVisible) return;   // recorded in history/sessions, just not shown

  const card = document.createElement('div');
  card.className = `tip-card ${tip.source || 'system'}${tip.death ? ' death' : ''}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = tip.death ? '<span class="src-skull">💀</span>' : '<span class="src-dot"></span>';
  meta.append(tip.death ? 'Death Review' : sourceLabel(tip.source));
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

// The old bottom-left status pill is gone for good: the overlay shows tips
// and the match review, nothing else. Status lives on the panel.
function setStatus() {}

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
  'middle':       'bottom center',
};
function setTipScale(scale) {
  const s = Number(scale);
  const val = s > 0 && isFinite(s) ? Math.min(1.5, Math.max(0.6, s)) : 1;
  tipsEl.style.transform = val === 1 ? '' : `scale(${val})`;
  tipsEl.style.transformOrigin = SCALE_ORIGIN[tipsEl.dataset.pos] || 'top right';
}

// ── Match review ─────────────────────────────────────────────────────────────
// One compact stat chip: label + value, plus a small green/red arrow with the
// change vs the previous match when we have one.
function statChip(label, value, prevValue, suffix = '') {
  const el = document.createElement('span');
  el.className = 'stat-chip';
  const b = document.createElement('b');
  b.textContent = `${value}${suffix}`;
  el.append(`${label} `, b);
  const cur = Number(value), prev = Number(prevValue);
  if (isFinite(cur) && isFinite(prev) && prev > 0 && cur !== prev) {
    const up = cur > prev;
    const d = Math.abs(cur - prev);
    const i = document.createElement('i');
    i.className = up ? 'up' : 'down';
    i.textContent = `${up ? '▲' : '▼'}${d < 1 ? d.toFixed(2) : Math.round(d)}`;
    el.append(' ', i);
  }
  return el;
}

function statsRow(delta) {
  if (!delta || !delta.current) return null;
  const cur = delta.current, prev = delta.prev || {};
  const row = document.createElement('div');
  row.className = 'stats';
  if (cur.rank && cur.rank !== 'Unknown') {
    const r = document.createElement('span');
    r.className = 'stat-chip';
    const b = document.createElement('b');
    b.textContent = cur.rank;
    r.append(b);
    row.append(r);
  }
  if (Number(cur.kd) > 0)          row.append(statChip('K/D', cur.kd, prev.kd));
  if (Number(cur.kpr) > 0)         row.append(statChip('KPR', cur.kpr, prev.kpr));
  if (Number(cur.adr) > 0)         row.append(statChip('ADR', cur.adr, prev.adr));
  if (Number(cur.acs) > 0)         row.append(statChip('ACS', cur.acs, prev.acs));
  if (Number(cur.headshotPct) > 0) row.append(statChip('HS', cur.headshotPct, prev.headshotPct, '%'));
  if (Number(cur.winRate) > 0)     row.append(statChip('Win', cur.winRate, prev.winRate, '%'));
  return row.children.length ? row : null;
}

// The real tracker match this session produced: result, KDA, ACS, ADR, grade.
function lastMatchRow(lm) {
  if (!lm || !lm.result) return null;
  const row = document.createElement('div');
  row.className = 'stats';
  const res = document.createElement('span');
  res.className = `stat-chip result ${lm.result === 'Victory' ? 'win' : lm.result === 'Defeat' ? 'loss' : ''}`;
  const rb = document.createElement('b');
  rb.textContent = `${lm.result} ${lm.score || ''}`.trim();
  res.append(rb);
  row.append(res);
  if (lm.map && lm.map !== 'Unknown') row.append(statChip('', lm.map));
  row.append(statChip('KDA', `${lm.kills}/${lm.deaths}/${lm.assists}`));
  if (Number(lm.acs) > 0) row.append(statChip('ACS', lm.acs));
  if (Number(lm.adr) > 0) row.append(statChip('ADR', lm.adr));
  if (Number(lm.headshotPct) > 0) row.append(statChip('HS', lm.headshotPct, undefined, '%'));
  if (lm.grade) row.append(statChip('Rating', lm.grade));
  return row;
}

function showReview(data) {
  if (!data || !data.review) return;
  reviewEl.hidden = false;
  reviewEl.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'review-card';
  const h = document.createElement('h3');
  h.innerHTML = '<span class="src-dot"></span>';
  h.append('Match Review');
  const closeBtn = document.createElement('button');
  closeBtn.className = 'review-close';
  closeBtn.title = 'Dismiss';
  closeBtn.textContent = '✕';
  h.append(closeBtn);
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = data.review;
  card.append(h, body);
  const match = lastMatchRow(data.lastMatch);
  if (match) card.append(match);
  const stats = statsRow(data.statsDelta);
  if (stats) card.append(stats);
  reviewEl.append(card);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    window.ghost.setInteractive(false);   // always hand the mouse back to the game
    card.classList.add('out');
    setTimeout(() => { reviewEl.hidden = true; reviewEl.innerHTML = ''; }, 300);
  };
  closeBtn.addEventListener('click', dismiss);
  // The overlay is click-through; while the cursor is over the card, main
  // accepts mouse input so the ✕ is clickable, released on leave.
  card.addEventListener('mouseenter', () => window.ghost.setInteractive(true));
  card.addEventListener('mouseleave', () => window.ghost.setInteractive(false));
  timer = setTimeout(dismiss, 22000);
}

// ── Voice coach ──────────────────────────────────────────────────────────────
// Speaks tips through the system's local voices (offline, free). A new tip
// cancels whatever is still being said, stale advice read late is bad advice.
const VOICE_STYLES = {
  normal: { rate: 1.0,  pitch: 1.0  },
  hype:   { rate: 1.13, pitch: 1.15, pre: ['Lock in.', "Let's go.", 'Big round.'], preChance: 0.25 },
  chill:  { rate: 0.88, pitch: 0.85 },
  funny:  { rate: 1.22, pitch: 1.65, pre: ['Yo!', 'Bro.', 'Listen!'], preChance: 0.35 },
  robot:  { rate: 0.92, pitch: 0.3  },
};
let voiceCfg = { enabled: false, style: 'normal', volume: 0.9 };

function speakTip(tip) {
  if (!voiceCfg.enabled || !tip || !tip.text) return;
  if (tip.source !== 'ai' && tip.source !== 'library') return;   // never voice system notices
  try {
    const style = VOICE_STYLES[voiceCfg.style] || VOICE_STYLES.normal;
    let text = tip.text;
    if (style.pre && Math.random() < (style.preChance || 0)) {
      text = style.pre[Math.floor(Math.random() * style.pre.length)] + ' ' + text;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = style.rate;
    u.pitch = style.pitch;
    u.volume = Math.max(0, Math.min(1, voiceCfg.volume));
    speechSynthesis.speak(u);
  } catch (e) { console.error('[overlay] voice failed:', e.message); }
}

// ── Subscriptions ────────────────────────────────────────────────────────────
window.ghost.onTip((tip) => { addTip(tip); speakTip(tip); });
window.ghost.onStatus(({ status }) => setStatus(status));
window.ghost.onState((s) => {
  if (s) {
    setStatus(s.status); setTipPosition(s.tipPosition); setTipScale(s.tipScale); setShowTips(s.showTips);
    voiceCfg = { enabled: s.voiceCoach === true, style: s.voiceStyle || 'normal',
                 volume: s.voiceVolume != null ? s.voiceVolume : 0.9 };
  }
});
window.ghost.onMatchReview(showReview);
window.ghost.onVisibility(({ visible }) => {
  document.body.classList.toggle('hidden-overlay', !visible);
});

console.log('[overlay] ready');
