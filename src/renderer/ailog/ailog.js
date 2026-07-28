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
  ['clock', 'clock'], ['phase', 'phase'],
  ['playerHp', 'health', 'key'],            // the ground truth for being alive
  ['playerAlive', 'alive', 'alive'],
  ['playerSpot', 'location', 'key'], ['teamScore', 'your score'], ['enemyScore', 'their score'],
  ['teammatesAlive', 'mates alive'], ['enemiesAlive', 'foes alive'],
  ['playerWeapon', 'weapon'], ['playerCredits', 'credits'],
  ['spike', 'spike', 'key'], ['spikeSpot', 'spike at', 'key'],
  ['killFeed', 'kill feed'],
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
  shownEl.replaceChildren();
  // Death reviews are labelled here the same way the overlay labels them, so
  // the log and the in-game card agree about what you were shown.
  if (shown && r.shown.death) shownEl.appendChild(el('span', 'death-tag', '\u{1F480} Death Review'));
  shownEl.appendChild(document.createTextNode(shown || 'No tip shown this frame (SKIP or filtered).'));
  shownEl.classList.toggle('none', !shown);
  // Show the model's own tip whenever it differs from what you saw, plus WHY it
  // was dropped. A rejected AI tip usually gets backfilled by a library tip, so
  // "something was shown" does not mean the AI's tip made it through.
  const raw = String(r.aiTip || '').trim();
  const showRaw = (raw && raw.toUpperCase() !== 'SKIP' && raw !== shown) || !!r.reject;
  $('raw-block').hidden = !showRaw;
  if (showRaw) {
    $('raw').textContent = raw || '(nothing usable)';
    const why = $('raw-why');
    why.textContent = r.reject ? 'Dropped: ' + r.reject : '';
    why.hidden = !r.reject;
  }

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

  // The chat follows the frame you are looking at.
  if (typeof paintConversation === 'function') paintConversation();
}

function go(to) { idx = Math.max(0, Math.min(records.length - 1, to)); render(); }

/**
 * Pin a skull on the scrubber for every frame that showed a death review, so
 * the deaths in a session are findable at a glance instead of by scrubbing.
 *
 * Built once after load, because the set never changes while the log is open.
 * Older logs recorded no `death` flag at all, so they simply get no marks
 * rather than wrong ones.
 */
function buildMarks() {
  const box = $('marks');
  box.replaceChildren();
  if (records.length < 2) return;

  records.forEach((r, i) => {
    if (!(r.shown && r.shown.death)) return;
    const b = el('button', 'mark-death', '\u{1F480}');
    b.type = 'button';
    b.style.left = `${(i / (records.length - 1)) * 100}%`;
    b.title = `Death review at frame ${i + 1}: ${r.shown.text || ''}`;
    b.addEventListener('click', () => go(i));
    box.appendChild(b);
  });
}

// ── Ask the coach about the frame you are looking at ────────────────────────
// The conversation is per frame: stepping to a different moment starts a fresh
// one, because a follow-up about another frame would otherwise be answered with
// the previous frame's context.
const askLog = $('ask-log');
const askInput = $('ask-input');
const askSend = $('ask-send');
let conversations = {};          // frame index -> [{ role, content }]

function paintConversation() {
  askLog.textContent = '';
  for (const m of conversations[idx] || []) {
    askLog.appendChild(el('div', 'ask-msg ' + (m.role === 'assistant' ? 'coach' : m.role === 'error' ? 'err' : 'you'), m.content));
  }
  askLog.scrollTop = askLog.scrollHeight;
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q || askSend.disabled) return;
  const at = idx;                                   // the frame this is about
  conversations[at] = conversations[at] || [];
  conversations[at].push({ role: 'user', content: q });
  askInput.value = '';
  askSend.disabled = true;
  paintConversation();
  const waiting = el('div', 'ask-msg wait', 'Looking at the frame...');
  askLog.appendChild(waiting);
  askLog.scrollTop = askLog.scrollHeight;

  try {
    const res = await window.ghost.ask({
      index: at,
      question: q,
      // Only this frame's history, so the coach is never answering about a
      // moment the player has already scrolled away from.
      history: conversations[at].slice(0, -1),
    });
    const reply = res && res.reply;
    conversations[at].push(reply
      ? { role: 'assistant', content: reply }
      : { role: 'error', content: (res && res.error) || 'No answer came back.' });
  } catch (e) {
    conversations[at].push({ role: 'error', content: 'Could not reach the coach.' });
  } finally {
    askSend.disabled = false;
    if (at === idx) paintConversation();
  }
}

$('ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask(askInput.value); });
for (const b of document.querySelectorAll('.hint')) {
  b.addEventListener('click', () => ask(b.dataset.q));
}

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
  const deaths = records.filter((r) => r.shown && r.shown.death).length;
  $('subtitle').textContent = deaths
    ? `${records.length} frames from your latest session, ${deaths} death ${deaths === 1 ? 'review' : 'reviews'}`
    : `${records.length} frames from your latest session`;
  buildMarks();
  // Jump to the most recent frame first, that is usually what you want to review.
  go(records.length - 1);
}).catch((err) => {
  $('empty').hidden = false;
  $('empty').textContent = 'Could not load the AI log.';
  console.error('[ailog] load failed', err);
});

console.log('[ailog] ready');
