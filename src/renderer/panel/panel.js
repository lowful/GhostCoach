'use strict';

const toggleBtn = document.getElementById('toggle');
const toggleIco = toggleBtn.querySelector('.t-ico');
const toggleLbl = toggleBtn.querySelector('.t-label');
const pauseBtn  = document.getElementById('pause');
const forceBtn  = document.getElementById('force');
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
    forceBtn.disabled = true;
    return;
  }
  statusEl.classList.remove('ended');
  toggleBtn.disabled = false;

  const status = isCoaching ? (isPaused ? 'paused' : 'coaching') : 'idle';
  dotEl.className = `dot ${status}`;
  statusEl.textContent = STATUS_LABEL[status];
  tipCountEl.textContent = `${tipCount} ${tipCount === 1 ? 'tip' : 'tips'}`;

  toggleLbl.textContent = isCoaching ? 'Stop Coaching' : 'Start Coaching';
  toggleIco.textContent = isCoaching ? '■' : '▶';
  toggleBtn.classList.toggle('active', isCoaching);
  pauseBtn.disabled = !isCoaching;
  forceBtn.disabled = !isCoaching;
  pauseBtn.textContent = isPaused ? '▶' : '⏸';
}

// ── Controls ─────────────────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  if (isCoaching) window.ghost.stopCoaching();
  else            window.ghost.startCoaching();
});
pauseBtn.addEventListener('click', () => window.ghost.pauseResume());
forceBtn.addEventListener('click', () => window.ghost.forceTip());
document.getElementById('chat').addEventListener('click', () => window.ghost.openChat());
document.getElementById('stats').addEventListener('click', () => window.ghost.openStats());
document.getElementById('history').addEventListener('click', () => window.ghost.openHistory());
document.getElementById('minimize').addEventListener('click', () => window.ghost.minimize());
document.getElementById('settings').addEventListener('click', () => window.ghost.openSettings());
document.getElementById('quit').addEventListener('click', () => window.ghost.quit());
lastTipEl.addEventListener('click', () => window.ghost.openHistory());

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
}
function showDetecting() { if (!agentAnswered) { formActive = false; showRow('detect'); } }
function showConfirm(name) {
  if (agentAnswered) return;
  formActive = false;
  abName.textContent = name;
  showRow('ask');
}
function showForm() {
  if (agentAnswered) return;
  formActive = true;
  showRow('form');
  abInput.classList.remove('bad');
  abInput.value = '';
  abInput.placeholder = 'Type your agent';
  setTimeout(() => abInput.focus(), 30);
}
function showDoneAndHide(name) {
  agentAnswered = true;
  formActive = false;
  abDoneName.textContent = '✓ ' + name;
  showRow('done');
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = setTimeout(hideAgentUI, 1600);
}

document.getElementById('ab-yes').addEventListener('click', () => window.ghost.confirmAgent());
document.getElementById('ab-no').addEventListener('click', showForm);
abForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = abInput.value.trim();
  if (!val) return;
  window.ghost.setAgent(val).then((res) => {
    if (!res || !res.ok) {
      abInput.classList.add('bad');
      abInput.value = '';
      abInput.placeholder = 'Not found, try again';
      setTimeout(() => abInput.focus(), 20);
    }
    // success comes back as a PUSH_AGENT (confirmed) → showDoneAndHide
  }).catch(() => {});
});

window.ghost.onAgent((info) => {
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
  isCoaching = !!s.isCoaching;
  isPaused   = !!s.isPaused;
  if (typeof s.tipCount === 'number') tipCount = s.tipCount;
  if (typeof s.licenseActive === 'boolean') licenseActive = s.licenseActive;
  // Force-tip button is opt-in via Settings (the Ctrl+Shift+X hotkey always works).
  if (typeof s.forceTipButton === 'boolean') forceBtn.hidden = !s.forceTipButton;
  render();
  if (!isCoaching) { sessionActive = false; agentAnswered = false; hideAgentUI(); }
}

window.ghost.onState(applyState);
window.ghost.onStatus(({ status }) => {
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
window.ghost.onTip((tip) => {
  if (!tip || !tip.text) return;
  lastTipText.textContent = tip.text;
  lastTipEl.title = tip.text;   // full text on hover, never cut off
  lastTipEl.className = `last-tip no-drag has-tip ${tip.source || 'system'} flash`;
  setTimeout(() => lastTipEl.classList.remove('flash'), 500);
});

window.ghost.getState().then(applyState).catch(() => {});
render();

// Keep the window sized to the panel's content (bubble show/hide, tip length),
// so there's never an invisible click-catching strip over the game.
const panelEl = document.querySelector('.panel');
let lastSentH = 0;
function syncHeight() {
  const h = Math.ceil(panelEl.getBoundingClientRect().height) + 20; // + 10px top/bottom margin
  if (Math.abs(h - lastSentH) > 1) { lastSentH = h; window.ghost.resizePanel(h); }
}
if (window.ResizeObserver) new ResizeObserver(syncHeight).observe(panelEl);
window.addEventListener('load', syncHeight);
setTimeout(syncHeight, 60);

console.log('[panel] ready');
