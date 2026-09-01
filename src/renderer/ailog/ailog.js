'use strict';

/**
 * AI decision-log viewer. Scrubs through a session's analyzed frames, each
 * paired with the STATE the coach parsed (its notes) and the tip. Text only,
 * never innerHTML: STATE and tips are AI-written strings.
 *
 * The last five sessions are kept on disk and any of them can be opened from the
 * picker, but only one is ever loaded. Frames are the expensive part, running
 * several megabytes a session before base64 inflates them, so the picker is
 * built from metadata alone and a switch pays for exactly one session.
 */
const $ = (id) => document.getElementById(id);
let records = [];
let idx = 0;
let sessionId = null;   // which session is loaded; rides along with every question
let segments = [];      // confirmed map stretches, from the main process
let deaths = [];        // every death found in the frames, reviewed or not

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

  // The map for the stretch this frame sits in. Deliberately NOT r.state.map:
  // that is one frame's guess, and one frame's guess is wrong often enough that
  // showing it here would contradict the timeline directly above it.
  const seg = segments.find((s) => idx >= s.from && idx <= s.to);
  const segEl = $('seg');
  if (!seg || !seg.map) {
    segEl.textContent = segments.length ? 'map not confirmed' : '';
    segEl.className = 'seg unsure';
    segEl.title = 'The location names on screen were not enough to identify the map.';
  } else {
    const n = segments.filter((s) => s.map).length;
    segEl.textContent = seg.map + (n > 1 ? ` (${segments.indexOf(seg) + 1} of ${n})` : '');
    segEl.className = 'seg' + (seg.confirmed ? '' : ' unsure');
    segEl.title = seg.confirmed
      ? `Confirmed: the AI read ${seg.byModel} and the ${seg.labels} location names on screen also fingerprint ${seg.byLabel}.`
      : `Unconfirmed: the AI read ${seg.byModel || 'nothing usable'}, the location names point to ${seg.byLabel || 'nothing definite'}. The location names are trusted.`;
  }

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
    // These notes are the model's raw reads, so this row can disagree with the
    // confirmed map above. Saying so is the point of showing both: a silent
    // disagreement is the reader deciding which one to believe with no help.
    if (key === 'map' && seg && seg.map && v !== seg.map) {
      const bad = el('span', 'misread', `misread, it was ${seg.map}`);
      bad.title = 'This one frame named a different map to the one confirmed for this stretch of the session.';
      row.appendChild(bad);
    }
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

  // Map changes first, so a death marker on the same frame draws on top of it.
  // Only CONFIRMED changes are pinned: the AI's map read flickers to a wrong map
  // for a frame or two several times a session, and a marker for each would
  // claim the player changed map nine times in one game.
  segments.slice(1).forEach((s) => {
    const b = el('button', 'mark-map', s.map || '?');
    b.type = 'button';
    b.style.left = `${(s.from / (records.length - 1)) * 100}%`;
    b.title = `Map changed to ${s.map || 'an unidentified map'} at frame ${s.from + 1}`;
    b.addEventListener('click', () => go(s.from));
    box.appendChild(b);
  });

  // EVERY death, not only the ones the coach reviewed. Marking review tips meant
  // the timeline stopped wherever the coaching stopped: the engine sends at most
  // two reviews per death and then stays quiet until the next buy phase, so on a
  // real session it pinned 5 marks for 8 deaths and the other three could not be
  // found by scrubbing at all.
  deaths.forEach((d) => {
    const b = el('button', 'mark-death' + (d.reviewed ? '' : ' unreviewed'), '\u{1F480}');
    b.type = 'button';
    b.style.left = `${(d.at / (records.length - 1)) * 100}%`;
    const who = d.killedBy ? ` to ${d.killedBy}` : '';
    const where = d.round ? ` in round ${d.round}` : '';
    b.title = d.reviewed
      ? `Death${where}${who}, reviewed by the coach. Frame ${d.at + 1}.`
      : `Death${where}${who}, no review was shown. Frame ${d.at + 1}.`;
    b.addEventListener('click', () => go(d.at));
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
// Keyed by session AND frame, not frame alone. Frame numbers restart in every
// session, so an index-only key would show Tuesday's answer under tonight's
// twelfth frame, which reads as the coach contradicting itself.
let conversations = {};          // "session:index" -> [{ role, content }]
const convKey = (i) => `${sessionId}:${i}`;

function paintConversation() {
  askLog.textContent = '';
  for (const m of conversations[convKey(idx)] || []) {
    askLog.appendChild(el('div', 'ask-msg ' + (m.role === 'assistant' ? 'coach' : m.role === 'error' ? 'err' : 'you'), m.content));
  }
  askLog.scrollTop = askLog.scrollHeight;
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q || askSend.disabled) return;
  const at = idx;                                   // the frame this is about
  const key = convKey(at);
  const from = sessionId;                           // and the session it belongs to
  conversations[key] = conversations[key] || [];
  conversations[key].push({ role: 'user', content: q });
  askInput.value = '';
  askSend.disabled = true;
  paintConversation();
  const waiting = el('div', 'ask-msg wait', 'Looking at the frame...');
  askLog.appendChild(waiting);
  askLog.scrollTop = askLog.scrollHeight;

  try {
    const res = await window.occlara.ask({
      session: from,        // or main would answer from the newest session's frames
      index: at,
      question: q,
      // Only this frame's history, so the coach is never answering about a
      // moment the player has already scrolled away from.
      history: conversations[key].slice(0, -1),
    });
    const reply = res && res.reply;
    conversations[key].push(reply
      ? { role: 'assistant', content: reply }
      : { role: 'error', content: (res && res.error) || 'No answer came back.' });
  } catch (e) {
    conversations[key].push({ role: 'error', content: 'Could not reach the coach.' });
  } finally {
    askSend.disabled = false;
    if (at === idx && from === sessionId) paintConversation();
  }
}

$('ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask(askInput.value); });
for (const b of document.querySelectorAll('.hint')) {
  b.addEventListener('click', () => ask(b.dataset.q));
}

$('close').addEventListener('click', () => window.occlara.close());
$('prev').addEventListener('click', () => go(idx - 1));
$('next').addEventListener('click', () => go(idx + 1));
$('slider').addEventListener('input', (e) => go(Number(e.target.value)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.occlara.close();
  else if (e.key === 'ArrowLeft') go(idx - 1);
  else if (e.key === 'ArrowRight') go(idx + 1);
});

// ── Sessions ────────────────────────────────────────────────────────────────
const picker = $('session');

/** "Today 21:35" / "Tue 21:35", since a bare timestamp is hard to place. */
function sessionWhen(at) {
  if (!at) return 'unknown time';
  const d = new Date(at);
  const clock = d.toTimeString().slice(0, 5);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clock}`;
}

/** A session covers however long you coached for, which can be several matches,
 *  so the label names the maps rather than pretending it is one game. */
function sessionLabel(s) {
  const bits = [s.live ? `Current · ${sessionWhen(s.at)}` : sessionWhen(s.at)];
  if (s.maps && s.maps.length) bits.push(s.maps.length > 2 ? `${s.maps[0]} +${s.maps.length - 1}` : s.maps.join(', '));
  bits.push(`${s.frames} frames`);
  if (s.deaths) bits.push(`${s.deaths} death${s.deaths === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

function paintPicker(sessions) {
  picker.replaceChildren();
  for (const s of sessions) {
    const o = el('option', null, sessionLabel(s));
    o.value = s.id;
    picker.appendChild(o);
  }
  picker.value = sessionId || (sessions[0] && sessions[0].id) || '';
  // With one session there is nothing to switch between, so the control would
  // only be clutter on the surface it is least wanted on.
  picker.hidden = sessions.length < 2;
}

function loadSession(id) {
  picker.disabled = true;
  $('subtitle').textContent = 'Loading frames...';
  return window.occlara.getLog(id).then((log) => {
    records = (log && Array.isArray(log.records)) ? log.records : [];
    segments = (log && Array.isArray(log.segments)) ? log.segments : [];
    deaths = (log && Array.isArray(log.deaths)) ? log.deaths : [];
    sessionId = (log && log.session) || null;
    paintPicker((log && log.sessions) || []);
    picker.disabled = false;

    if (!records.length) {
      $('main').hidden = true;
      $('empty').hidden = false;
      $('empty').textContent = 'No AI log yet. Start a coaching session (with the AI log enabled in Settings) and the frames the coach reads will show up here to review.';
      $('subtitle').textContent = 'what the coach saw and said';
      return;
    }
    $('empty').hidden = true;
    $('main').hidden = false;
    $('slider').max = String(records.length - 1);
    const which = (log.sessions || []).find((s) => s.id === sessionId);
    const when = which ? sessionWhen(which.at).toLowerCase() : 'your latest session';
    // Deaths and reviews are counted separately, because they are different
    // numbers and the gap between them is the useful part: it says how many
    // times you died without the coach telling you anything about it.
    const seen = deaths.filter((d) => d.reviewed).length;
    $('subtitle').textContent = deaths.length
      ? `${records.length} frames from ${when}, ${deaths.length} death${deaths.length === 1 ? '' : 's'}, ${seen} reviewed`
      : `${records.length} frames from ${when}`;
    buildMarks();
    // Jump to the most recent frame first, that is usually what you want to review.
    go(records.length - 1);
    confirmDeaths(sessionId);
  }).catch((err) => {
    picker.disabled = false;
    $('main').hidden = true;
    $('empty').hidden = false;
    $('empty').textContent = 'Could not load the AI log.';
    console.error('[ailog] load failed', err);
  });
}

picker.addEventListener('change', () => loadSession(picker.value));

/**
 * Ask Riot whether the deaths on this timeline are the real ones.
 *
 * Fired AFTER the session is drawn, never before, so the log opens instantly and
 * still works with no network and no Riot ID. A session that cannot be checked
 * simply shows nothing extra, because the screen-read deaths are still the best
 * answer available and an error banner would suggest otherwise.
 */
function confirmDeaths(forSession) {
  const box = $('confirm');
  box.hidden = true;
  if (!window.occlara.confirm) return;
  window.occlara.confirm(forSession).then((rec) => {
    if (!rec || forSession !== sessionId) return;          // switched away meanwhile
    if (rec.status === 'unavailable' || !rec.summary) return;
    box.hidden = false;
    box.className = 'confirm ' + rec.status;
    box.replaceChildren();
    box.appendChild(el('span', 'dot'));
    box.appendChild(el('span', null, rec.summary));

    // When the counts agree the pairing is trustworthy, so each mark can carry
    // the real round, killer and weapon instead of the model's reading of them.
    if (rec.pairs && rec.pairs.length) {
      const marks = [...document.querySelectorAll('#marks .mark-death')];
      rec.pairs.forEach((p, i) => {
        const d = deaths[i];
        if (!d || !marks[i]) return;
        d.round = p.round; d.killedBy = p.killer; d.weapon = p.weapon; d.confirmed = true;
        marks[i].title = `Round ${p.round}: killed by ${p.killer}${p.weapon ? ` with a ${p.weapon}` : ''}`
          + `${d.reviewed ? ', reviewed by the coach' : ', no review was shown'}. Confirmed by Riot.`;
      });
    }
  }).catch(() => { /* a confirmation that does not arrive changes nothing */ });
}

/*
 * Opened at a session somebody asked for, when they did.
 *
 * Tip History links straight to the frames behind the tips it is showing, and
 * hands the log session id over in the URL hash. The hash is there before the
 * first line of this file runs, which is why it is used rather than a message:
 * a message sent while the window is still loading is simply lost.
 *
 * An unknown id falls back to the newest inside ai-log-store's read(), so a
 * session pruned between the click and the open still shows something.
 */
function requestedSession() {
  try {
    const raw = decodeURIComponent(String(location.hash || '').replace(/^#/, '')).trim();
    // Only ever a session folder name, never a path. Anything else is ignored
    // rather than joined onto one.
    return /^session-[\w.-]+$/.test(raw) ? raw : undefined;
  } catch { return undefined; }
}

loadSession(requestedSession());

// An already open window is told to move, since the hash was read once above.
if (window.occlara.onShow) window.occlara.onShow((id) => loadSession(id));

console.log('[ailog] ready');
