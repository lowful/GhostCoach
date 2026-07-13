'use strict';

const cardsEl        = document.getElementById('cards');
const matchListEl    = document.getElementById('match-list');
const matchEmptyEl   = document.getElementById('match-empty');
const sessionListEl  = document.getElementById('session-list');
const sessionEmptyEl = document.getElementById('session-empty');
const updatedEl      = document.getElementById('updated');
const refreshBtn     = document.getElementById('refresh');

const ARROW = { up: '▲', down: '▼', flat: '-' };
let lastFetchedAt = 0;
let refreshBlockedUntil = 0;

// ── Overview cards ────────────────────────────────────────────────────────────
function card(label, value, direction, small) {
  const el = document.createElement('div');
  el.className = 'card';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  const row = document.createElement('div');
  row.className = 'val-row';
  const v = document.createElement('span');
  v.className = 'value' + (small ? ' small' : '');
  v.textContent = value == null ? '·' : value;
  const a = document.createElement('span');
  a.className = `arrow ${direction || 'flat'}`;
  a.textContent = ARROW[direction] || ARROW.flat;
  row.append(v, a);
  el.append(l, row);
  return el;
}

function renderCards(d) {
  cardsEl.innerHTML = '';
  const c = d.categories || {};
  cardsEl.append(
    card('Economy',     c.economy?.avg,     c.economy?.direction),
    card('Positioning', c.positioning?.avg, c.positioning?.direction),
    card('Utility',     c.utility?.avg,     c.utility?.direction),
    card('Aim',         c.aim?.avg,         c.aim?.direction),
    card('Rank',        d.rank?.value,      d.rank?.direction, true),
    card('Win Rate',    d.winRate?.value != null ? d.winRate.value + '%' : null, d.winRate?.direction),
  );
}

// ── Recent matches ────────────────────────────────────────────────────────────
function ratingClass(r) { return r >= 85 ? 'great' : r >= 70 ? 'good' : r >= 55 ? 'mid' : 'low'; }

function matchRow(m) {
  const row = document.createElement('div');
  row.className = `row ${m.result === 'Victory' ? 'win' : m.result === 'Defeat' ? 'loss' : ''}`;
  const top = document.createElement('div');
  top.className = 'top';
  const place = document.createElement('span');
  place.className = 'place';
  place.textContent = m.map || 'Unknown';
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = m.agent || '';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const kda = document.createElement('span');
  kda.className = 'kda';
  kda.textContent = `${m.kills}/${m.deaths}/${m.assists}`;
  const res = document.createElement('span');
  res.className = `res ${m.result === 'Victory' ? 'win' : 'loss'}`;
  res.textContent = m.result === 'Victory' ? `Win ${m.score}` : `Loss ${m.score}`;
  const rating = document.createElement('span');
  rating.className = `rating ${ratingClass(m.rating)}`;
  rating.textContent = m.rating;
  rating.title = 'Match rating (0-100)';
  top.append(place, sub, spacer, kda, res, rating);
  row.append(top);
  return row;
}

function timeAgo(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)}h ago`;
}

function renderMatches(res) {
  matchListEl.innerHTML = '';
  const matches = (res && res.matches) || [];
  lastFetchedAt = (res && res.fetchedAt) || lastFetchedAt;
  if (res && res.refreshBlockedFor) refreshBlockedUntil = Date.now() + res.refreshBlockedFor;
  updatedEl.textContent = lastFetchedAt ? `Last updated ${timeAgo(lastFetchedAt)}` : '';

  if (!matches.length) {
    matchEmptyEl.hidden = false;
    matchEmptyEl.textContent = res && res.error === 'no-riot-id'
      ? 'Connect your Riot ID in Settings to see your recent matches here.'
      : 'No recent matches found yet. Matches appear a few minutes after they end.';
    return;
  }
  matchEmptyEl.hidden = true;
  for (const m of matches) matchListEl.append(matchRow(m));
}

// Manual refresh, rate limited to once per 3 minutes (mirrored on the server).
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Refreshing';
  try {
    const res = await window.ghost.refreshMatches();
    if (!(res && res.refreshBlockedFor)) refreshBlockedUntil = Date.now() + 3 * 60 * 1000;
    renderMatches(res);
  } catch {}
  tickRefresh();
});

function tickRefresh() {
  const left = refreshBlockedUntil - Date.now();
  if (left > 0) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = `Refresh in ${Math.ceil(left / 1000)}s`;
  } else {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  }
  if (lastFetchedAt) updatedEl.textContent = `Last updated ${timeAgo(lastFetchedAt)}`;
}
setInterval(tickRefresh, 1000);

// ── Coaching sessions ─────────────────────────────────────────────────────────
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Anticipation-then-reveal: the overall score counts up from 0, matching the
 *  match-review flow's reveal treatment instead of dropping a static number. */
function revealScore(el, target, delay) {
  const start = performance.now() + delay;
  const DUR = 700;
  function frame(now) {
    if (now < start) return requestAnimationFrame(frame);
    const t = Math.min(1, (now - start) / DUR);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(target * eased);
    if (t < 1) requestAnimationFrame(frame);
    else el.classList.add(ratingClass(target));
  }
  requestAnimationFrame(frame);
}

function sessionRow(s, i) {
  const row = document.createElement('div');
  row.className = 'row session';
  const top = document.createElement('div');
  top.className = 'top';
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▶';
  const place = document.createElement('span');
  place.className = 'place';
  place.textContent = fmtDate(s.at);
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = [s.map, s.agent].filter(Boolean).join(' · ');
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const score = document.createElement('span');
  score.className = 'rating';
  score.title = 'Session score (average of the four categories)';
  score.textContent = '0';
  revealScore(score, s.overall || 0, 150 + i * 120);
  top.append(chev, place, sub, spacer, score);

  const detail = document.createElement('div');
  detail.className = 'detail';
  const scores = document.createElement('div');
  scores.className = 'scores4';
  for (const [label, key] of [['Economy', 'economy'], ['Positioning', 'positioning'], ['Utility', 'utility'], ['Aim', 'aim']]) {
    const chip = document.createElement('span');
    chip.className = 'sc';
    chip.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = (s.scores && s.scores[key] != null) ? s.scores[key] : '·';
    chip.append(label + ' ', b);
    scores.append(chip);
  }
  const sl = document.createElement('div'); sl.className = 'd-label s'; sl.textContent = 'Strengths';
  const sp = document.createElement('p');   sp.textContent = s.strengths || 'No strengths recorded for this session.';
  const wl = document.createElement('div'); wl.className = 'd-label w'; wl.textContent = 'Weaknesses';
  const wp = document.createElement('p');   wp.textContent = s.weaknesses || 'No weaknesses recorded for this session.';
  const ask = document.createElement('button');
  ask.className = 'ask-btn no-drag';
  ask.textContent = 'Ask Coach about this';
  ask.addEventListener('click', (e) => {
    e.stopPropagation();
    window.ghost.askAboutSession({
      date: fmtDate(s.at), map: s.map, overall: s.overall,
      scores: s.scores, strengths: s.strengths, weaknesses: s.weaknesses,
    });
  });
  detail.append(scores, sl, sp, wl, wp, ask);
  row.append(top, detail);
  row.addEventListener('click', () => row.classList.toggle('open'));
  return row;
}

function renderSessions(d) {
  sessionListEl.innerHTML = '';
  const sessions = d.sessions || [];
  // Fewer than 3 coached sessions: a clean empty state beats a sparse list.
  if ((d.sessionCount || 0) < 3) {
    sessionEmptyEl.hidden = false;
    return;
  }
  sessionEmptyEl.hidden = true;
  sessions.forEach((s, i) => sessionListEl.append(sessionRow(s, i)));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function load() {
  try {
    const d = await window.ghost.getDashboard();
    if (!d) return;
    renderCards(d);
    renderMatches(d.matches);
    renderSessions(d);
  } catch (e) {
    console.error('[stats] load failed', e);
  }
}

document.getElementById('askcoach').addEventListener('click', () => window.ghost.openChat());
document.getElementById('close').addEventListener('click', () => window.close());
load();
console.log('[stats] ready');
