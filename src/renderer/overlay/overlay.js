'use strict';

// Overlay labels come from JS, so they need a translator. Defaults to English
// until i18n resolves, which matters here because the overlay can show a tip
// within a second of launch.
let ovLang = 'en';
function ovT(key) {
  try { return window.occlara.i18n.t(ovLang, key); } catch { return key === 'overlay.deathReview' ? 'Death Review' : key; }
}


const tipsEl   = document.getElementById('tips');
const reviewEl = document.getElementById('review');

const TIP_TTL = 11000;     // auto-dismiss after 11s
const MAX_VISIBLE = 4;

/* Kept for the match review card, which genuinely benefits from a source. Tip
   cards no longer use it: a player mid round does not need to be told which
   part of the app produced the sentence. */
function sourceLabel(src) {
  if (src === 'ai') return 'Coach';
  if (src === 'library') return 'Tip';
  return 'Review';
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
  // THE CARD IS THE TIP, and nothing else.
  //
  // It used to open with a coloured dot and the word "Occlara" or "Coach" above
  // every single line of advice. On screen mid round that is two pieces of
  // furniture in front of the one sentence a player has about a second and a
  // half to read, and the source was never information they could act on. A
  // death review still gets a label, because "this is about the death you just
  // took" changes how the sentence should be read, but it is a word rather than
  // an emoji.
  const text = document.createElement('div');
  text.className = 'text';
  // Glyphs mark the callout, the direction and the agent so the sentence is
  // scanned rather than read. The words are untouched; this decorates what the
  // coach said and never rewrites it. Falls back to plain text if the shared
  // script is missing, because a tip must always render.
  if (window.tipVisuals) window.tipVisuals.render(text, tip.text, { topic: tip.topic });
  else text.textContent = tip.text;
  let meta = null;
  if (tip.death) {
    meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = ovT('overlay.deathReview');
  }
  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.style.animationDuration = TIP_TTL + 'ms';
  if (meta) card.append(meta);
  card.append(text, progress);

  tipsEl.prepend(card);
  // Count and evict CARDS, not children. The live indicator is also a child of
  // this container, so counting children let it eat one of the four slots, and
  // evicting lastElementChild dismissed the indicator instead of the oldest
  // tip whenever the stack was full.
  // :not(.out) so cards already animating away are not counted twice, which
  // would also make this loop unable to terminate.
  const live = () => tipsEl.querySelectorAll('.tip-card:not(.out)');
  for (let cards = live(); cards.length > MAX_VISIBLE; cards = live()) {
    dismiss(cards[cards.length - 1]);
  }

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
//
// Coaching going live is the one exception, and it is not a pill. The coach
// used to announce itself in a full tip card ("Coach is live. Trust your
// reads"), which is a sentence the player reads once, never needs again, and
// gets while loading into a round. It also burned one of the four visible card
// slots. This shows the mark instead: it appears, pulses twice, and leaves.
//
// It is appended INSIDE #tips rather than positioning itself, so it lands
// wherever the player put their tips and follows the position setting for
// free, including the centre stack.
const LIVE_MS = 2900;

function flashLive() {
  if (!tipsVisible) return;                       // tips hidden means show nothing
  const existing = tipsEl.querySelector('.live');
  if (existing) existing.remove();                // never stack two

  const el = document.createElement('div');
  el.className = 'live';
  const img = document.createElement('img');
  // The one mark file, not a fifth inline copy of it.
  img.src = '../../../assets/logo-mark.svg';
  img.width = 26; img.height = 26; img.alt = '';
  el.appendChild(img);
  tipsEl.appendChild(el);
  setTimeout(() => el.remove(), LIVE_MS);
}

// Only the transition INTO coaching is worth showing. PUSH_STATUS re-broadcasts
// the current status whenever anything else about the state changes, so without
// this the mark would flash again every time the player paused, changed a
// setting, or finished a round.
let lastStatus = null;
function setStatus(status) {
  if (status === 'coaching' && lastStatus !== 'coaching') flashLive();
  lastStatus = status;
}

function setTipPosition(pos) {
  if (pos) tipsEl.dataset.pos = pos;
}

// Card look and see-through amount. Both are single values the CSS reads, so
// changing them in Settings re-skins the live stack with no re-render.
const TIP_STYLES = ['glass', 'solid', 'minimal', 'neon'];
function setTipStyle(style) {
  tipsEl.dataset.style = TIP_STYLES.includes(style) ? style : 'glass';
}
function setTipOpacity(v) {
  const n = Number(v);
  const val = isFinite(n) && n > 0 ? Math.min(1, Math.max(0.25, n)) : 0.9;
  tipsEl.style.setProperty('--tip-alpha', val);
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
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
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
    window.occlara.setInteractive(false);   // always hand the mouse back to the game
    card.classList.add('out');
    setTimeout(() => { reviewEl.hidden = true; reviewEl.innerHTML = ''; }, 300);
  };
  closeBtn.addEventListener('click', dismiss);
  // The overlay is click-through; while the cursor is over the card, main
  // accepts mouse input so the ✕ is clickable, released on leave.
  card.addEventListener('mouseenter', () => window.occlara.setInteractive(true));
  card.addEventListener('mouseleave', () => window.occlara.setInteractive(false));
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
window.occlara.onTip((tip) => { addTip(tip); speakTip(tip); });
window.occlara.onStatus(({ status }) => setStatus(status));
function applyState(s) {
  if (!s) return;
  setStatus(s.status); setTipPosition(s.tipPosition); setTipScale(s.tipScale); setShowTips(s.showTips);
  setTipStyle(s.tipStyle); setTipOpacity(s.tipOpacity);
  voiceCfg = { enabled: s.voiceCoach === true, style: s.voiceStyle || 'normal',
               volume: s.voiceVolume != null ? s.voiceVolume : 0.9 };
}
window.occlara.onState(applyState);
// Hydrate immediately rather than waiting for the first push, so the saved
// position, size and card style are already correct on the very first tip.
window.occlara.getState().then(applyState).catch(() => {});
window.occlara.onMatchReview(showReview);
window.occlara.onVisibility(({ visible }) => {
  document.body.classList.toggle('hidden-overlay', !visible);
});

console.log('[overlay] ready');

if (window.occlara && window.occlara.getConfig) {
  const syncLang = () => window.occlara.getConfig()
    .then((c) => { ovLang = (c && c.language) || 'en'; })
    .catch(() => {});
  syncLang();
  if (typeof window.occlara.onState === 'function') window.occlara.onState(syncLang);
}
