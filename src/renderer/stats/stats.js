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
let matchMode = 'competitive';   // always opens on Competitive; Unrated = unrated + swiftplay

// ── Session MVP badges ───────────────────────────────────────────────────────
// Sessions are not tied to a match id, so link them by time and map: a match
// that started inside the session's coaching window is the match that session
// coached. Matches from every loaded mode bucket accumulate in knownMatches.
const knownMatches = new Map();   // match id -> { startedAt, map, mvp }
const sessionMvpSlots = [];       // { s, slot } placeholders on rendered session rows

function annotateSessionMvps() {
  for (const { s, slot } of sessionMvpSlots) {
    if (slot.dataset.done) continue;
    const start = (s.at || 0) - ((s.durationMin || 0) + 20) * 60000;
    const end   = (s.at || 0) + 10 * 60000;
    for (const m of knownMatches.values()) {
      if (!m.mvp || !m.startedAt || m.startedAt < start || m.startedAt > end) continue;
      if (s.map && m.map && s.map !== m.map) continue;
      slot.dataset.done = '1';
      slot.className = `mvp ${m.mvp}`;
      slot.textContent = m.mvp === 'match' ? 'MVP' : 'Team MVP';
      slot.hidden = false;
      break;
    }
  }
}

// Mode toggle: same ratings, same treatment, just not ranked.
// Sequenced so a slow older response can never overwrite a newer mode, and
// re-clicking always retries (the old early-return left it stuck when the
// first fetch failed, the "have to click a couple times" glitch).
let matchSeq = 0;
async function loadMatches(mode) {
  const seq = ++matchSeq;
  matchListEl.innerHTML = '';
  matchEmptyEl.hidden = false;
  matchEmptyEl.textContent = 'Loading matches...';
  try {
    const res = await window.ghost.matchesFor(mode);
    if (seq !== matchSeq || mode !== matchMode) return;   // superseded by a newer click
    renderMatches(res);
  } catch {
    if (seq === matchSeq) matchEmptyEl.textContent = 'Could not load matches. Click the mode again to retry.';
  }
}

const modeSeg = document.getElementById('modeseg');
modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  matchMode = btn.dataset.mode;   // re-clicking the same mode retries on purpose
  for (const b of modeSeg.querySelectorAll('button')) b.classList.toggle('active', b === btn);
  refreshBlockedUntil = 0;
  loadMatches(matchMode);
  refreshDashboardForMode(matchMode);   // overview + agents follow the queue too
});

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

// Per-rank field notes: what the rank is about and the mistakes that keep
// players hardstuck there, distilled from Radiant coaching material.
const RANK_NOTES = {
  iron: { summary: 'The foundations rank, rounds are decided by raw gun handling before anything else.',
    issues: ['Spamming pistols instead of respecting each gun\'s reset time, the Ghost, Classic, and Sheriff each have their own rhythm between accurate shots',
      'Crosshair drifting to the floor or walls between fights',
      'Fix it in the Range at 10 meters: slow down until your shots stop flying up, then speed back up'] },
  bronze: { summary: 'Utility exists here, but it works against the team as often as for it.',
    issues: ['Panic dumping abilities the moment enemies are seen or heard, a solo dart at round start that nobody can swing on helps no one',
      'Bad utility is worse than none, a bad smoke blocks your own team\'s crossfires and gives free space',
      'Before every ability, ask what it does for the team right now. No answer in one sentence, do not press the key'] },
  silver: { summary: 'Aim starts landing, and confidence becomes the trap.',
    issues: ['Ego peeking and overheating: one kill, then an instant swing for more into someone you missed',
      'Chasing clips instead of winning rounds',
      'The fix is disciplined aggression: after a kill ask if more is risky, and if yes, reposition and play with your team'] },
  gold: { summary: 'Just enough map awareness to talk yourself into bad rotations.',
    issues: ['Panic rotating off one utility sound or a few footsteps, gold is the easiest rank in the game to fake',
      'Leaving your site free the moment noise happens elsewhere',
      'Learn to anchor: pick your site and do not leave until enemies are actually confirmed hitting the other one'] },
  platinum: { summary: 'The duels are fine, the economy and macro are out of sync with the team.',
    issues: ['Hero buys while the team saves, one selfish rifle creates two or three mismatched rounds after it',
      'Buying on feeling instead of what the team can afford together',
      'Press Tab before every buy and match the team: save together, buy together'] },
  diamond: { summary: 'Skilled but predictable, the same script every round gets pre aimed.',
    issues: ['Running the same "if X then Y" in the same spot every round, enemies need only a few rounds to read it',
      'Feeling constantly one tapped is often just being predictable',
      'Condition your opponents: teach them a pattern, then break it, and rotate your setups between rounds'] },
  ascendant: { summary: 'The accidental baiter rank: smart positioning that leaves teammates fighting alone.',
    issues: ['Sitting too far behind the entry to trade, arriving after the duelist is already dead',
      'The trade window is 1 to 2 seconds after contact, outside it the trade is gone forever',
      'Stay within a step or two of your entry on attack, and pair up on defense so every fight gets answered'] },
  immortal: { summary: 'Mechanics are Radiant level, the gap is mental endurance and consistency.',
    issues: ['Checking out after unlucky clutches or toxic teammates, then throwing the rounds that decide the game',
      'Inconsistency across a full match, not a lack of skill',
      'Play every round like the score is 12 to 12: three seconds of breath before each buy phase, then the best play'] },
  radiant: { summary: 'The top. Staying here is pure consistency, every round played like overtime.',
    issues: ['Complacency, streaks end on relaxed rounds',
      'Keep the 12 to 12 mindset that got you here'] },
};

function rankTier(rankValue) {
  const l = String(rankValue || '').toLowerCase();
  return Object.keys(RANK_NOTES).find((t) => l.startsWith(t)) || null;
}

const rankNotesEl = document.getElementById('rank-notes');

// ── Rank journey graph: competitive RR movement, drawn as an SVG line ────────
async function renderRankGraph(host, opts) {
  const old = host.querySelector('.rank-graph');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'rank-graph';
  wrap.innerHTML = '<div class="rg-loading">Loading your rank journey...</div>';
  host.prepend(wrap);
  let res = null;
  try { res = await window.ghost.rankHistory(!!(opts && opts.force)); } catch {}
  let points = (res && !res.error && Array.isArray(res.points)) ? res.points : [];
  // Placements and act resets make elo leap by hundreds and fake absurd RR
  // gains (+1535 from "Unrated" to Diamond). Keep only rated games, then cut
  // at the newest discontinuity so the graph covers one honest stretch, and
  // report net RR as the sum of per-game changes, what was actually gained.
  points = points.filter((p) => p.elo > 0 && p.tier && !/unrated|unranked/i.test(p.tier));
  let startIdx = 0;
  for (let i = points.length - 1; i > 0; i--) {
    if (Math.abs(points[i].elo - points[i - 1].elo) > 300) { startIdx = i; break; }
  }
  points = points.slice(startIdx);
  if (points.length < 2) { wrap.remove(); return; }

  const W = 560, H = 130, PAD = 10;
  const elos = points.map((p) => p.elo);
  const min = Math.min(...elos), max = Math.max(...elos);
  const span = Math.max(max - min, 20);
  const x = (i) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (e) => H - PAD - ((e - min) / span) * (H - PAD * 2);
  const path = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.elo).toFixed(1)).join(' ');
  const net = points.reduce((sum, p) => sum + (p.change || 0), 0);
  const last = points[points.length - 1];

  wrap.innerHTML = `
    <div class="rg-head">
      <span class="rg-title">Rank journey · last ${points.length} comp games</span>
      <span class="rg-net ${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '+' : ''}${net} RR</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="rgFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(0,240,255,0.25)"/>
          <stop offset="1" stop-color="rgba(0,240,255,0)"/>
        </linearGradient>
      </defs>
      <path d="${path} L ${x(points.length - 1).toFixed(1)} ${H - PAD} L ${x(0).toFixed(1)} ${H - PAD} Z" fill="url(#rgFill)" stroke="none"/>
      <path d="${path}" fill="none" stroke="#00F0FF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.elo).toFixed(1)}" r="4" fill="#00F0FF"/>
    </svg>
    <div class="rg-foot">
      <span>${points[0].tier || ''}</span>
      <span>${last.tier || ''}${last.change != null ? ' · last game ' + (last.change >= 0 ? '+' : '') + last.change + 'RR' : ''}</span>
    </div>`;
}

function toggleRankNotes(rankValue) {
  if (!rankNotesEl.hidden) { rankNotesEl.hidden = true; return; }
  const tier = rankTier(rankValue);
  rankNotesEl.innerHTML = '';
  renderRankGraph(rankNotesEl);   // graph on top, insights below
  const title = document.createElement('h4');
  const body  = document.createElement('p');
  if (!tier) {
    title.textContent = 'Rank insights';
    body.textContent = 'Connect your Riot ID in Settings and play ranked to see what typically holds players back at your rank.';
    rankNotesEl.append(title, body);
  } else {
    const n = RANK_NOTES[tier];
    title.textContent = `About ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;
    body.textContent = n.summary;
    const label = document.createElement('div');
    label.className = 'rn-label';
    label.textContent = 'Why players get stuck here';
    const ul = document.createElement('ul');
    for (const issue of n.issues) {
      const li = document.createElement('li');
      li.textContent = issue;
      ul.append(li);
    }
    rankNotesEl.append(title, body, label, ul);
  }
  rankNotesEl.hidden = false;
}

function renderCards(d) {
  cardsEl.innerHTML = '';
  const rankCard = card('Rank', d.rank?.value, d.rank?.direction, true);
  rankCard.classList.add('clickable');
  const chev = document.createElement('span');
  chev.className = 'rank-chev';
  chev.textContent = '▾';
  rankCard.querySelector('.label').append(' ', chev);
  rankCard.title = 'What holds players back at this rank';
  rankCard.addEventListener('click', () => toggleRankNotes(d.rank && d.rank.value));
  const c = d.categories || {};
  cardsEl.append(
    card('Impact',      c.impact?.avg,      c.impact?.direction),
    card('Positioning', c.positioning?.avg, c.positioning?.direction),
    card('Utility',     c.utility?.avg,     c.utility?.direction),
    card('Aim',         c.aim?.avg,         c.aim?.direction),
    rankCard,
    card('Win Rate',    d.winRate?.value != null ? d.winRate.value + '%' : null, d.winRate?.direction),
  );
}

// ── Recent matches ────────────────────────────────────────────────────────────
function ratingClass(r) { return r >= 85 ? 'great' : r >= 70 ? 'good' : r >= 55 ? 'mid' : 'low'; }

// Grade a per-match stat for the tile colors: g = good, y = okay, r = bad.
// Thresholds follow common tracker expectations for competitive play.
function grade(kind, v) {
  if (v == null) return '';
  switch (kind) {
    case 'kd':   return v >= 1.2 ? 'g' : v >= 0.9  ? 'y' : 'r';
    case 'acs':  return v >= 230 ? 'g' : v >= 180  ? 'y' : 'r';
    case 'adr':  return v >= 150 ? 'g' : v >= 120  ? 'y' : 'r';
    case 'hs':   return v >= 20  ? 'g' : v >= 12   ? 'y' : 'r';
    case 'kpr':  return v >= 0.8 ? 'g' : v >= 0.6  ? 'y' : 'r';
    case 'dpr':  return v <= 0.7 ? 'g' : v <= 0.85 ? 'y' : 'r';   // lower is better
    case 'apr':  return v >= 0.4 ? 'g' : v >= 0.2  ? 'y' : 'r';
    case 'dmg':  return v >= 20  ? 'g' : v >= -20  ? 'y' : 'r';   // damage +/- per round
    default:     return '';
  }
}

function statTile(label, value, gradeClass) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  const l = document.createElement('span');
  l.className = 't-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = `t-val ${gradeClass || ''}`;
  v.textContent = value == null ? '·' : value;
  tile.append(l, v);
  return tile;
}

function matchRow(m) {
  const row = document.createElement('div');
  row.className = `row expandable ${m.result === 'Victory' ? 'win' : m.result === 'Defeat' ? 'loss' : ''}`;
  const top = document.createElement('div');
  top.className = 'top';
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▶';
  const place = document.createElement('span');
  place.className = 'place';
  place.textContent = m.map || 'Unknown';
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = [m.agent, m.queue && m.queue !== 'Competitive' ? m.queue : null].filter(Boolean).join(' · ');
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
  top.append(chev, place, sub, spacer, kda, res);
  if (m.mvp) {
    const mvp = document.createElement('span');
    mvp.className = `mvp ${m.mvp}`;
    mvp.textContent = m.mvp === 'match' ? 'MVP' : 'Team MVP';
    mvp.title = m.mvp === 'match'
      ? 'Match MVP, top combat score on the winning team'
      : 'Team MVP, top combat score on your team';
    top.append(mvp);
  }
  top.append(rating);

  // Drop-down: the tracker's most important stats, graded green/yellow/red.
  const detail = document.createElement('div');
  detail.className = 'detail';
  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  const dmgVal = m.dmgDelta == null ? null : (m.dmgDelta > 0 ? '+' + m.dmgDelta : String(m.dmgDelta));
  tiles.append(
    statTile('K/D',        m.kd,          grade('kd',  m.kd)),
    statTile('ACS',        m.acs,         grade('acs', m.acs)),
    statTile('ADR',        m.adr,         grade('adr', m.adr)),
    statTile('HS%',        m.headshotPct != null ? m.headshotPct + '%' : null, grade('hs', m.headshotPct)),
    statTile('Kills/Rd',   m.kpr,         grade('kpr', m.kpr)),
    statTile('Deaths/Rd',  m.dpr,         grade('dpr', m.dpr)),
    statTile('Assists/Rd', m.apr,         grade('apr', m.apr)),
    statTile('Dmg +/- Rd', dmgVal,        grade('dmg', m.dmgDelta)),
  );
  const share = document.createElement('div');
  share.className = 'share-row';
  const gen = document.createElement('button');
  gen.className = 'share-btn';
  gen.textContent = 'Generate card';
  gen.addEventListener('click', async (e) => {
    e.stopPropagation();
    gen.textContent = 'Generating...';
    let card = null;
    try { card = await buildMatchCard(m); } catch {}
    if (!card) { gen.textContent = 'Failed, try again'; return; }
    gen.remove();
    const flashBtn = (btn, text) => {
      const orig = btn.textContent;
      btn.textContent = text;
      setTimeout(() => { btn.textContent = orig; }, 1400);
    };
    const saveBtn = document.createElement('button');
    saveBtn.className = 'share-btn';
    saveBtn.textContent = 'Save card';
    saveBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const a = document.createElement('a');
      a.download = `ghostcoach-${(m.map || 'match').toLowerCase()}-${m.kills}-${m.deaths}.png`;
      a.href = card.toDataURL('image/png');
      a.click();
      flashBtn(saveBtn, 'Saved!');
    });
    const copyBtn = document.createElement('button');
    copyBtn.className = 'share-btn';
    copyBtn.textContent = 'Copy card';
    copyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      card.toBlob(async (b) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
          flashBtn(copyBtn, 'Copied!');
        } catch { flashBtn(copyBtn, 'Failed'); }
      });
    });
    share.append(saveBtn, copyBtn);
  });
  share.append(gen);
  detail.append(tiles, share);
  row.append(top, detail);
  row.addEventListener('click', () => row.classList.toggle('open'));
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
  for (const m of matches) if (m.id) knownMatches.set(m.id, m);
  annotateSessionMvps();
  matches.forEach((m, i) => {
    const r = matchRow(m);
    r.style.animationDelay = Math.min(i * 40, 400) + 'ms';   // staggered entrance
    matchListEl.append(r);
  });
}

// Manual refresh, rate limited to once per 3 minutes (mirrored on the server).
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Refreshing';
  try {
    const seq = ++matchSeq;
    const res = await window.ghost.refreshMatches(matchMode);
    if (!(res && res.refreshBlockedFor)) refreshBlockedUntil = Date.now() + 3 * 60 * 1000;
    if (seq === matchSeq && (!res.mode || res.mode === matchMode)) renderMatches(res);
  } catch {}
  refreshDashboardForMode(matchMode, true);   // agents + overview stay fresh too
  rrPointsCache = null;                       // RR moved? scorecards see it fresh
  if (!rankNotesEl.hidden) renderRankGraph(rankNotesEl, { force: true });
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
  row.className = 'row expandable session';
  row.style.animationDelay = Math.min(i * 50, 400) + 'ms';   // staggered entrance
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
  const mvpSlot = document.createElement('span');
  mvpSlot.hidden = true;   // fills in when a known match links to this session
  sessionMvpSlots.push({ s, slot: mvpSlot });
  const score = document.createElement('span');
  score.className = 'rating';
  score.title = 'Session score (average of the four categories)';
  score.textContent = '0';
  revealScore(score, s.overall || 0, 150 + i * 120);
  top.append(chev, place, sub, spacer, mvpSlot, score);

  const detail = document.createElement('div');
  detail.className = 'detail';
  const scores = document.createElement('div');
  scores.className = 'scores4';
  for (const [label, key] of [['Impact', 'impact'], ['Positioning', 'positioning'], ['Utility', 'utility'], ['Aim', 'aim']]) {
    const chip = document.createElement('span');
    chip.className = 'sc';
    chip.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = (s.scores && s.scores[key] != null) ? s.scores[key] : '·';
    chip.append(label + ' ', b);
    scores.append(chip);
  }
  // The coach's spoken-style recap of the session, front and center.
  const rl = document.createElement('div'); rl.className = 'd-label r'; rl.textContent = "Coach's recap";
  const rp = document.createElement('p');   rp.textContent = s.summary || 'No recap recorded for this session.';
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
  detail.append(scores, rl, rp, sl, sp, wl, wp, ask);
  row.append(top, detail);
  row.addEventListener('click', () => row.classList.toggle('open'));
  return row;
}

// ── Shareable scorecard: a flashy PNG built on canvas ────────────────────────
const cardLogo = new Image();
cardLogo.src = '../../../assets/logo-ghost.svg';

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function matchForSession(s) {
  const start = (s.at || 0) - ((s.durationMin || 0) + 20) * 60000;
  const end   = (s.at || 0) + 10 * 60000;
  let best = null;
  for (const m of knownMatches.values()) {
    if (!m.startedAt || m.startedAt < start || m.startedAt > end) continue;
    if (s.map && m.map && s.map !== m.map) continue;
    if (!best || m.startedAt > best.startedAt) best = m;
  }
  return best;
}
function mvpForSession(s) {
  const m = matchForSession(s);
  return m ? m.mvp || null : null;
}

// Competitive RR change for a match, from the rank history points (nearest
// game within 45 minutes). Cached per window; Refresh clears it.
let rrPointsCache = null;
async function rrPoints(force) {
  if (rrPointsCache && !force) return rrPointsCache;
  try {
    const r = await window.ghost.rankHistory(force);
    rrPointsCache = (r && !r.error && Array.isArray(r.points)) ? r.points : [];
  } catch { rrPointsCache = []; }
  return rrPointsCache;
}
async function rrChangeForMatch(m) {
  if (!m || !m.startedAt || m.queue !== 'Competitive') return null;
  const pts = await rrPoints();
  let best = null;
  for (const p of pts) {
    if (!p.date || Math.abs(p.date - m.startedAt) > 45 * 60000) continue;
    if (!best || Math.abs(p.date - m.startedAt) < Math.abs(best.date - m.startedAt)) best = p;
  }
  return best && best.change != null ? best.change : null;
}

async function buildMatchCard(m) {
  if (!cardLogo.complete) await new Promise((res) => { cardLogo.onload = res; cardLogo.onerror = res; });
  try { await document.fonts.ready; } catch {}   // Inter must be loaded before canvas text
  const rrChange = await rrChangeForMatch(m);
  const icons = await loadAgentIcons();
  const entry = icons[String(m.agent || '').toLowerCase()];
  // crossOrigin keeps the canvas exportable; a tainted canvas cannot be saved
  const portrait = entry && entry.portrait ? await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = entry.portrait;
  }) : null;

  // Display faces if the player has them installed, Inter otherwise.
  const DISPLAY = 'Coolvetica, Konnect, Inter, sans-serif';
  const BODY = 'Inter, sans-serif';

  const W = 1000, H = 560, L = 48;   // L = the one left margin everything shares
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const shadowOn  = () => { ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 2; };
  const shadowOff = () => { ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };

  ctx.fillStyle = '#06080e'; ctx.fillRect(0, 0, W, H);

  // Angular shards, randomized so every card is one of one
  for (let i = 0; i < 8; i++) {
    const sx = W * 0.5 + Math.random() * W * 0.5;
    const sy = Math.random() * H;
    const ang = Math.random() * Math.PI * 2;
    const len = 140 + Math.random() * 260;
    const wid = 16 + Math.random() * 46;
    ctx.fillStyle = ['rgba(52,74,140,0.20)', 'rgba(255,70,85,0.10)', 'rgba(0,240,255,0.08)'][i % 3];
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
    ctx.lineTo(sx + Math.cos(ang + 0.22) * (len * 0.72) + wid, sy + Math.sin(ang + 0.22) * (len * 0.72));
    ctx.closePath();
    ctx.fill();
  }

  if (portrait && portrait.naturalWidth) {
    const ph = H + 46;
    const pw = ph * (portrait.naturalWidth / portrait.naturalHeight);
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.drawImage(portrait, W - pw * 0.84, H - ph + 18, pw, ph);
    ctx.restore();
    const fade = ctx.createLinearGradient(W * 0.4, 0, W * 0.68, 0);
    fade.addColorStop(0, 'rgba(6,8,14,0.96)');
    fade.addColorStop(1, 'rgba(6,8,14,0)');
    ctx.fillStyle = fade; ctx.fillRect(W * 0.4, 0, W * 0.28, H);
  }

  // Header: the one ghost logo with the wordmark beside it
  if (cardLogo.naturalWidth) ctx.drawImage(cardLogo, L, 34, 30, 36);
  ctx.textAlign = 'left';
  shadowOn();
  ctx.fillStyle = '#ECF9FF'; ctx.font = '800 26px ' + DISPLAY;
  ctx.fillText('GHOSTCOACH', L + 42, 60);

  // Player name + context line
  const riot = (dashRiotId || '').trim();
  const name = riot.split('#')[0] || 'GhostCoach Player';
  ctx.fillStyle = '#F4FBFF'; ctx.font = '800 56px ' + DISPLAY;
  ctx.fillText(name.slice(0, 16), L, 158);
  const dateStr = m.startedAt
    ? new Date(m.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase()
    : null;
  ctx.fillStyle = 'rgba(175,205,225,0.8)'; ctx.font = '500 15px ' + BODY;
  ctx.fillText([m.agent, m.map, m.queue, dateStr].filter(Boolean).join('  ·  ').toUpperCase(), L + 2, 196);
  shadowOff();

  // The pill leads with the GhostCoach match rating (0-100, tracker-derived)
  const rating = Math.round(m.rating || 0);
  const pillCol = rating >= 70 ? ['#2BE58D', '#19c97a'] : rating >= 55 ? ['#ffd76a', '#eebc3f'] : ['#ff8a95', '#ff5f6e'];
  const pillW = 200, pillH = 80, pillY = 226;
  const pg = ctx.createLinearGradient(L, 0, L + pillW, 0);
  pg.addColorStop(0, pillCol[0]); pg.addColorStop(1, pillCol[1]);
  ctx.fillStyle = pg;
  ctx.shadowColor = pillCol[0]; ctx.shadowBlur = 24;
  rr(ctx, L, pillY, pillW, pillH, 16); ctx.fill();
  shadowOff();
  ctx.textAlign = 'center';
  ctx.font = '800 54px ' + DISPLAY;
  ctx.fillStyle = '#03140b';
  ctx.fillText(String(rating), L + pillW / 2, pillY + 57);
  ctx.textAlign = 'left';

  // MVP chip aligned with the pill's vertical center
  if (m.mvp) {
    const label = m.mvp === 'match' ? 'MATCH MVP' : 'TEAM MVP';
    const gold = m.mvp === 'match' ? '#ffd76a' : '#cfd8e3';
    ctx.font = '800 16px ' + BODY;
    const cw = ctx.measureText(label).width + 40;
    const mx = L + pillW + 18, my = pillY + (pillH - 40) / 2;
    ctx.shadowColor = gold; ctx.shadowBlur = 20;
    ctx.fillStyle = 'rgba(255,215,106,0.10)';
    rr(ctx, mx, my, cw, 40, 20); ctx.fill();
    shadowOff();
    ctx.strokeStyle = gold; ctx.lineWidth = 2;
    rr(ctx, mx, my, cw, 40, 20); ctx.stroke();
    ctx.fillStyle = gold;
    ctx.fillText(label, mx + 20, my + 26);
  }

  // Stat rows on a tight two-column grid: labels at L, values at L+140
  const kdaCol = m.kills > m.deaths ? '#2BE58D' : m.kills < m.deaths ? '#ff8a95' : '#ffd76a';
  const rows = [
    ['RESULT', (m.result === 'Victory' ? 'WIN ' : m.result === 'Defeat' ? 'LOSS ' : 'DRAW ') + m.score,
      m.result === 'Victory' ? '#2BE58D' : m.result === 'Defeat' ? '#ff8a95' : '#ECF9FF'],
    ['K / D / A', m.kills + ' / ' + m.deaths + ' / ' + m.assists, kdaCol],
  ];
  if (rrChange != null) rows.push(['RR', (rrChange >= 0 ? '+' : '') + rrChange + ' RR', rrChange >= 0 ? '#2BE58D' : '#ff8a95']);
  let ry = rows.length >= 3 ? 348 : 362;   // three rows start higher, two stay put
  shadowOn();
  for (const [label, value, color] of rows) {
    ctx.fillStyle = 'rgba(175,205,225,0.7)'; ctx.font = '500 16px ' + BODY;
    ctx.fillText(label, L, ry);
    ctx.fillStyle = color; ctx.font = '800 21px ' + DISPLAY;
    ctx.fillText(value, L + 140, ry);
    ry += 31;
  }
  shadowOff();

  // Stat tiles: the tracker numbers that matter, four equal boxes
  const dd = m.dmgDelta != null ? (m.dmgDelta >= 0 ? '+' : '') + m.dmgDelta : null;
  const cats = [['ACS', m.acs], ['ADR', m.adr], ['HS%', m.headshotPct != null ? m.headshotPct + '%' : null], ['DMG / RD', dd]];
  const bw = 122, bh = 52, gap = 12, by = 438;
  let bx = L;
  for (const [label, vRaw] of cats) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    rr(ctx, bx, by, bw, bh, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    rr(ctx, bx, by, bw, bh, 10); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(175,205,225,0.65)'; ctx.font = '500 10.5px ' + BODY;
    ctx.fillText(label, bx + bw / 2, by + 19);
    ctx.fillStyle = '#F4FBFF'; ctx.font = '800 20px ' + DISPLAY;
    ctx.fillText(vRaw == null ? '·' : String(vRaw), bx + bw / 2, by + 43);
    ctx.textAlign = 'left';
    bx += bw + gap;
  }

  // Bottom bar: full riot tag left, site right, one shared baseline
  shadowOn();
  ctx.fillStyle = '#F4FBFF'; ctx.font = '800 19px ' + DISPLAY;
  const tag = riot ? riot.slice(0, 26) : name;
  ctx.fillText(tag, L, 536);
  const tagW = ctx.measureText(tag).width;
  ctx.fillStyle = 'rgba(175,205,225,0.6)'; ctx.font = '500 19px ' + BODY;
  ctx.fillText('ghostcoachai.com', L + tagW + 28, 536);
  shadowOff();
  return cv;
}

function renderSessions(d) {
  sessionListEl.innerHTML = '';
  sessionMvpSlots.length = 0;   // rows are being rebuilt, drop stale slots
  const sessions = d.sessions || [];
  // Every graded session shows up (a session qualifies with multiple tips or
  // 5+ minutes of coaching); the empty state only appears with none at all.
  if (!sessions.length) {
    sessionEmptyEl.hidden = false;
    return;
  }
  sessionEmptyEl.hidden = true;
  sessions.forEach((s, i) => sessionListEl.append(sessionRow(s, i)));
  annotateSessionMvps();   // matches may have loaded first
}

// ── Top Agents ────────────────────────────────────────────────────────────────
const agentTilesEl = document.getElementById('agent-tiles');
const agentEmptyEl = document.getElementById('agent-empty');

// Agent portraits from the official Valorant asset API, cached for 7 days.
// Offline or blocked, tiles fall back to a lettered badge and stay clean.
let agentIconMap = null;
async function loadAgentIcons() {
  if (agentIconMap) return agentIconMap;
  try {
    const cached = JSON.parse(localStorage.getItem('agentIcons2') || 'null');
    if (cached && cached.map && Date.now() - cached.at < 7 * 24 * 3600000) return (agentIconMap = cached.map);
  } catch {}
  try {
    const r = await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true');
    const j = await r.json();
    const map = {};
    for (const a of (j && j.data) || []) {
      map[String(a.displayName).toLowerCase()] = { icon: a.displayIcon, portrait: a.fullPortrait };
    }
    localStorage.setItem('agentIcons2', JSON.stringify({ at: Date.now(), map }));
    return (agentIconMap = map);
  } catch {
    return (agentIconMap = {});
  }
}

function agentLetterBadge(name) {
  const s = document.createElement('span');
  s.className = 'agent-icon letter';
  s.textContent = (name || '?').slice(0, 1).toUpperCase();
  return s;
}

async function renderAgents(topAgents) {
  const list = Array.isArray(topAgents) ? topAgents : [];
  agentTilesEl.innerHTML = '';
  agentEmptyEl.hidden = list.length > 0;
  if (!list.length) return;
  const icons = await loadAgentIcons();
  list.forEach((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'agent-tile';
    tile.style.animationDelay = (i * 70) + 'ms';
    const entry = icons[String(a.name || '').toLowerCase()];
    const url = entry && entry.icon;
    let icon;
    if (url) {
      icon = document.createElement('img');
      icon.className = 'agent-icon';
      icon.src = url;
      icon.alt = a.name;
      icon.onerror = () => icon.replaceWith(agentLetterBadge(a.name));
    } else {
      icon = agentLetterBadge(a.name);
    }
    const info = document.createElement('div');
    info.className = 'agent-info';
    const nm = document.createElement('div');
    nm.className = 'agent-name';
    nm.textContent = a.name || 'Unknown';
    const played = document.createElement('div');
    played.className = 'agent-sub';
    played.textContent = `${a.matches} ${a.matches === 1 ? 'match' : 'matches'} · ${a.pct}%`;
    played.title = `${a.pct}% of your recent games`;
    const chips = document.createElement('div');
    chips.className = 'agent-chips';
    const wr = document.createElement('span');
    wr.className = `agent-chip ${a.winRate >= 55 ? 'good' : a.winRate <= 45 ? 'bad' : 'mid'}`;
    wr.textContent = `${a.winRate}% WR`;
    const kd = document.createElement('span');
    kd.className = `agent-chip ${a.kd >= 1.1 ? 'good' : a.kd < 0.9 ? 'bad' : 'mid'}`;
    kd.textContent = `${a.kd} KD`;
    const acs = document.createElement('span');
    acs.className = `agent-chip ${a.acs >= 220 ? 'good' : a.acs < 150 ? 'bad' : 'mid'}`;
    acs.textContent = `${a.acs} ACS`;
    chips.append(wr, kd, acs);
    info.append(nm, played, chips);
    tile.append(icon, info);
    agentTilesEl.append(tile);
  });
}

// The whole dashboard follows the mode toggle: overview numbers, agent tiles,
// and the match list all re-pull for the selected queue.
let dashSeq = 0;
async function refreshDashboardForMode(mode, force) {
  const seq = ++dashSeq;
  try {
    const d = await window.ghost.getDashboard(mode, !!force);
    if (!d || seq !== dashSeq || mode !== matchMode) return;   // superseded
    renderCards(d);
    renderAgents(d.topAgents);
  } catch {}
}

// ── Boot ──────────────────────────────────────────────────────────────────────
let dashRiotId = '';
async function load() {
  try {
    const d = await window.ghost.getDashboard(matchMode);
    if (!d) return;
    if (typeof d.riotId === 'string') dashRiotId = d.riotId;
    renderCards(d);
    renderAgents(d.topAgents);
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
