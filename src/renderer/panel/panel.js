'use strict';

// Translator for the labels this surface rewrites at runtime. Starts as an
// identity-ish fallback so the panel renders correctly even if i18n has not
// resolved yet, then initI18n swaps in the real one and repaints.
let tr = (k) => ({ 'panel.start': 'Start Coaching', 'panel.stop': 'Stop Coaching' }[k] || k);

const toggleBtn = document.getElementById('toggle');
const toggleIco = toggleBtn.querySelector('.t-ico');
const toggleLbl = toggleBtn.querySelector('.t-label');
const pauseBtn  = document.getElementById('pause');
// Icons as markup constants rather than glyph characters. These strings are
// entirely app-authored, never user or model text, so innerHTML is safe here in
// a way it deliberately is not for a tip.
//
// This also fixes a real break: the markup now ships an <svg> inside the toggle
// and the pause button, and assigning .textContent to those elements wiped it
// and replaced it with a character.
const ICO = {
  play:  '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none"><path d="M8 5.2v13.6a.6.6 0 0 0 .93.5l10.2-6.8a.6.6 0 0 0 0-1l-10.2-6.8A.6.6 0 0 0 8 5.2z"/></svg>',
  stop:  '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 5v14"/><path d="M15 5v14"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 7"/></svg>',
};

const dotEl     = document.getElementById('dot');
const statusEl  = document.getElementById('status-text');
const tipCountEl = document.getElementById('tipcount');
const lastTipEl = document.getElementById('last-tip');
const lastTipText = lastTipEl.querySelector('.lt-text');

// agent check bubble
const agentBubble = document.getElementById('agent-bubble');
const abDetect    = document.getElementById('ab-detect');
const abAsk       = document.getElementById('ab-ask');
const abForm      = document.getElementById('ab-form');
const abDone      = document.getElementById('ab-done');
const abName      = document.getElementById('ab-name');
const abDoneName  = document.getElementById('ab-done-name');
const abInput     = document.getElementById('ab-input');
const nudgeEl     = document.getElementById('nudge');
const abQuick     = document.getElementById('ab-quick');
const abQuickBtns = document.getElementById('ab-quick-btns');
let topAgents     = [];   // player's 4 most-played, from state, for one-tap select

let isCoaching = false;
let isPaused   = false;
let tipCount   = 0;
let licenseActive = true;   // false once the subscription ends (locks coaching)
let sessionActive  = false; // a coaching session is running (drives one bubble per session)
let agentAnswered  = false; // player has confirmed/typed their agent this session
let formActive     = false; // player is typing in the agent field (don't yank it away)
let doneTimer = null;

const STATUS_LABEL = { idle: 'Idle', coaching: 'Coaching', paused: 'Paused', stopped: 'Stopped' };

function render() {
  // Subscription ended: lock coaching and say so.
  if (!licenseActive) {
    dotEl.className = 'dot stopped';
    statusEl.textContent = 'Subscription ended';
    statusEl.classList.add('ended');
    tipCountEl.textContent = 'Renew in Settings';
    toggleBtn.disabled = true;
    toggleBtn.classList.remove('active');
    toggleLbl.textContent = 'Subscription ended';
    toggleIco.textContent = '⚠';
    pauseBtn.disabled = true;
    return;
  }
  statusEl.classList.remove('ended');
  toggleBtn.disabled = false;

  const status = isCoaching ? (isPaused ? 'paused' : 'coaching') : 'idle';
  dotEl.className = `dot ${status}`;
  statusEl.textContent = STATUS_LABEL[status];
  tipCountEl.textContent = `${tipCount} ${tipCount === 1 ? 'tip' : 'tips'}`;

  toggleLbl.textContent = tr(isCoaching ? 'panel.stop' : 'panel.start');
  toggleIco.innerHTML = isCoaching ? ICO.stop : ICO.play;
  toggleBtn.classList.toggle('active', isCoaching);
  // The session block carries the live class, so the status dot only breathes
  // while coaching is actually running.
  const sessionEl = document.querySelector('.session');
  if (sessionEl) sessionEl.classList.toggle('live', isCoaching);
  pauseBtn.disabled = !isCoaching;
  pauseBtn.innerHTML = isPaused ? ICO.play : ICO.pause;
}

// ── Controls ─────────────────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  if (isCoaching) window.occlara.stopCoaching();
  else            window.occlara.startCoaching();
});
pauseBtn.addEventListener('click', () => window.occlara.pauseResume());
document.getElementById('chat').addEventListener('click', () => window.occlara.openChat());
document.getElementById('stats').addEventListener('click', () => window.occlara.openStats());
document.getElementById('learn').addEventListener('click', () => window.occlara.openLearn());
document.getElementById('history').addEventListener('click', () => window.occlara.openHistory());
document.getElementById('minimize').addEventListener('click', () => window.occlara.minimize());
document.getElementById('settings').addEventListener('click', () => window.occlara.openSettings());
document.getElementById('quit').addEventListener('click', () => window.occlara.quit());
lastTipEl.addEventListener('click', () => window.occlara.openHistory());

// ── Agent check bubble ─────────────────────────────────────────────────────────
// Pops up once when coaching starts so the player confirms (or types) their agent
// with a single tap, then disappears for the rest of the session and returns next
// time coaching starts. The confirmed agent is what every tip is verified against,
// so the AI and library make the right calls.
const AB_ROWS = { detect: abDetect, ask: abAsk, form: abForm, done: abDone };
function showRow(which) {
  agentBubble.hidden = false;
  for (const [k, el] of Object.entries(AB_ROWS)) el.hidden = (k !== which);
}
function hideAgentUI() {
  formActive = false;
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
  agentBubble.hidden = true;
  abQuick.hidden = true;
}

// One-tap quick-picks for the player's most-played agents. Shown while the
// bubble is still asking (detect/confirm/type), so the usual case (playing a
// main) is a single tap instead of typing. Tapping sets the agent like the form.
function renderQuickPicks() {
  if (agentAnswered || !topAgents.length) { abQuick.hidden = true; return; }
  abQuickBtns.innerHTML = '';
  for (const name of topAgents) {
    const b = document.createElement('button');
    b.className = 'ab-quick-btn no-drag';
    b.type = 'button';
    b.textContent = name;
    b.title = name;   // names can ellipsis at four across
    b.addEventListener('click', () => {
      window.occlara.setAgent(name).catch(() => {});   // success returns via PUSH_AGENT
    });
    abQuickBtns.append(b);
  }
  abQuick.hidden = false;
}
function showDetecting() { if (!agentAnswered) { formActive = false; showRow('detect'); renderQuickPicks(); } }
function showConfirm(name) {
  if (agentAnswered) return;
  formActive = false;
  abName.textContent = name;
  showRow('ask');
  renderQuickPicks();
}
function showForm() {
  if (agentAnswered) return;
  formActive = true;
  showRow('form');
  abInput.classList.remove('bad');
  abInput.value = '';
  abInput.placeholder = 'Type your agent';
  renderQuickPicks();
  setTimeout(() => abInput.focus(), 30);
}
function showDoneAndHide(name) {
  agentAnswered = true;
  formActive = false;
  abQuick.hidden = true;
  abDoneName.innerHTML = ICO.check + ' ';
  abDoneName.append(name);
  showRow('done');
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = setTimeout(hideAgentUI, 1600);
}

document.getElementById('ab-yes').addEventListener('click', () => window.occlara.confirmAgent());
document.getElementById('ab-no').addEventListener('click', showForm);
abForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = abInput.value.trim();
  if (!val) return;
  window.occlara.setAgent(val).then((res) => {
    if (!res || !res.ok) {
      abInput.classList.add('bad');
      abInput.value = '';
      abInput.placeholder = 'Not found, try again';
      setTimeout(() => abInput.focus(), 20);
    }
    // success comes back as a PUSH_AGENT (confirmed) → showDoneAndHide
  }).catch(() => {});
});

window.occlara.onAgent((info) => {
  if (!isCoaching || agentAnswered) return;
  info = info || {};
  if (info.agent && info.confirmed) { showDoneAndHide(info.agent); return; }
  if (formActive) return;            // player is typing their agent; don't interrupt
  if (info.agent) showConfirm(info.agent);
  else            showForm();          // engine couldn't detect: ask directly
});

// ── State sync ───────────────────────────────────────────────────────────────
function applyState(s) {
  if (!s) return;
  // The Learn surface is League only, so its button appears only when League is
  // the game being coached. A control that does nothing for the game in front
  // of you is worse than one that is not there.
  const learnBtn = document.getElementById('learn');
  if (learnBtn && typeof s.gameId === 'string') learnBtn.hidden = s.gameId !== 'lol';
  isCoaching = !!s.isCoaching;
  isPaused   = !!s.isPaused;
  if (typeof s.tipCount === 'number') tipCount = s.tipCount;
  if (typeof s.licenseActive === 'boolean') licenseActive = s.licenseActive;
  if (Array.isArray(s.topAgents)) {
    topAgents = s.topAgents.slice(0, 3);
    if (!agentBubble.hidden && !agentAnswered) renderQuickPicks();   // fill in if stats arrived after the bubble
  }
  render();
  if (!isCoaching) { sessionActive = false; agentAnswered = false; hideAgentUI(); }
}

// ── Minimize hint ────────────────────────────────────────────────────────────
// The main process decides WHEN this is worth showing; the panel just presents
// it. Auto-dismisses so it never becomes another thing to click away mid-match.
let nudgeTimer = null;
function hideNudge() {
  if (nudgeEl.hidden) return;
  clearTimeout(nudgeTimer);
  nudgeEl.classList.add('out');
  setTimeout(() => { nudgeEl.hidden = true; nudgeEl.classList.remove("out"); syncHeight(); }, 220);
}
function showNudge() {
  clearTimeout(nudgeTimer);
  nudgeEl.hidden = false;
  syncHeight();
  nudgeTimer = setTimeout(hideNudge, 11000);   // long enough to read, short enough to forget
}
document.getElementById('nudge-x').addEventListener('click', hideNudge);
window.occlara.onNudge((n) => { if (n && n.kind === 'minimize') showNudge(); });

window.occlara.onState(applyState);
window.occlara.onStatus(({ status }) => {
  if (status === 'coaching') {
    isCoaching = true; isPaused = false;
    if (!sessionActive) {                 // a fresh start (not a resume from pause)
      sessionActive = true; agentAnswered = false;
      showDetecting();
    }
  } else if (status === 'paused') {
    isCoaching = true; isPaused = true;
  } else if (status === 'stopped' || status === 'idle') {
    isCoaching = false; isPaused = false;
    sessionActive = false; agentAnswered = false;
    hideAgentUI();
  }
  render();
});
window.occlara.onTip((tip) => {
  if (!tip || !tip.text) return;
  // Same glyphs as the overlay: the panel shows the last tip, and a callout
  // marked one way on screen and another way here would read as two systems.
  if (window.tipVisuals) window.tipVisuals.render(lastTipText, tip.text, { topic: tip.topic });
  else lastTipText.textContent = tip.text;
  lastTipEl.title = tip.text;   // full text on hover, never cut off
  lastTipEl.className = `last-tip no-drag has-tip ${tip.source || 'system'} flash`;
  setTimeout(() => lastTipEl.classList.remove('flash'), 500);
});

window.occlara.getState().then(applyState).catch(() => {});
render();

// Keep the window sized to the panel's content (bubble show/hide, tip length),
// so there's never an invisible click-catching strip over the game.
const panelEl = document.querySelector('.panel');
let lastSentH = 0;
function syncHeight() {
  const h = Math.ceil(panelEl.getBoundingClientRect().height) + 20; // + 10px top/bottom margin
  if (Math.abs(h - lastSentH) > 1) { lastSentH = h; window.occlara.resizePanel(h); }
}
if (window.ResizeObserver) new ResizeObserver(syncHeight).observe(panelEl);
window.addEventListener('load', syncHeight);
setTimeout(syncHeight, 60);

console.log('[panel] ready');
