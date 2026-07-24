'use strict';

const tipposSeg = document.getElementById('tippos');

function markSeg(seg, value) {
  for (const btn of seg.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.val === value);
  }
}

function wireSeg(seg, key) {
  seg.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    markSeg(seg, btn.dataset.val);
    await window.ghost.setConfig({ [key]: btn.dataset.val });
  });
}

wireSeg(tipposSeg, 'tipPosition');

// Tip background opacity. Stored 0..1, shown as a percentage.
const styleSegEl   = document.getElementById('tipstyle');
const opacityEl    = document.getElementById('tipopacity');
const opacityLabel = document.getElementById('tipopacity-label');
const opacitySection = opacityEl.closest('section');

// Minimal draws no panel at all, so there is no background to make more or
// less see-through. Rather than leave a slider that silently does nothing,
// disable it and say why.
function syncOpacityAvailability(style) {
  const off = style === 'minimal';
  opacityEl.disabled = off;
  if (opacitySection) {
    opacitySection.classList.toggle('disabled', off);
    const hint = opacitySection.querySelector('.hint');
    if (hint) {
      hint.textContent = off
        ? 'Minimal has no card behind the text, so there is nothing to fade. Pick another style to use this.'
        : 'How see-through the cards are. Lower shows more of the game behind them, higher is easier to read.';
    }
  }
}

styleSegEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  markSeg(styleSegEl, btn.dataset.val);
  syncOpacityAvailability(btn.dataset.val);
  await window.ghost.setConfig({ tipStyle: btn.dataset.val });
});

opacityEl.addEventListener('input', () => { opacityLabel.textContent = opacityEl.value + '%'; });
opacityEl.addEventListener('change', () => {
  window.ghost.setConfig({ tipOpacity: Number(opacityEl.value) / 100 }).catch(() => {});
});

// Tip frequency slider: far left = Minimal, far right = Max.
const FREQ_ORDER  = ['battery', 'balanced', 'performance', 'ultra', 'rapid', 'turbo'];
const FREQ_LABELS = ['Minimal', 'Default', 'Medium', 'High', 'High+', 'Max'];
const freqEl    = document.getElementById('tipfreq');
const freqLabel = document.getElementById('tipfreq-label');
freqEl.addEventListener('input', () => { freqLabel.textContent = FREQ_LABELS[Number(freqEl.value)] || 'Default'; });
freqEl.addEventListener('change', () => {
  window.ghost.setConfig({ performanceMode: FREQ_ORDER[Number(freqEl.value)] || 'balanced' }).catch(() => {});
});

// Booleans under the hood, on/off buttons in the UI.
function wireBoolSeg(id, key) {
  const seg = document.getElementById(id);
  seg.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    markSeg(seg, btn.dataset.val);
    await window.ghost.setConfig({ [key]: btn.dataset.val === 'on' }).catch(() => {});
  });
  return seg;
}
const showTipsSeg = wireBoolSeg('showtips', 'showTips');
const beginnerSeg = wireBoolSeg('beginner', 'beginnerTips');
const aiLogSeg    = wireBoolSeg('ailog', 'aiLog');

// Voice coach + Coach Cam: sub-controls grey out while the feature is off.
const voiceSeg = wireBoolSeg('voicecoach', 'voiceCoach');
const styleSeg = document.getElementById('voicestyle');
wireSeg(styleSeg, 'voiceStyle');
const voiceSub = document.getElementById('voice-sub');
voiceSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) voiceSub.classList.toggle('disabled', btn.dataset.val === 'off');
});
const volEl = document.getElementById('voicevol');
const volLabel = document.getElementById('voicevol-label');
volEl.addEventListener('input', () => { volLabel.textContent = volEl.value + '%'; });
volEl.addEventListener('change', () => {
  window.ghost.setConfig({ voiceVolume: Number(volEl.value) / 100 }).catch(() => {});
});


// Tip size: live label, saved as a ratio (1 = normal).
const scaleEl = document.getElementById('tipscale');
const scaleLabel = document.getElementById('tipscale-label');
function scaleText(v) { return v + '%' + (Number(v) === 100 ? ' (normal)' : ''); }
scaleEl.addEventListener('input', () => { scaleLabel.textContent = scaleText(scaleEl.value); });
scaleEl.addEventListener('change', () => {
  window.ghost.setConfig({ tipScale: Number(scaleEl.value) / 100 }).catch(() => {});
});

// Riot ID: save on change/blur (debounced enough for a text field).
const riotEl = document.getElementById('riotid');
let riotTimer = null;
riotEl.addEventListener('input', () => {
  clearTimeout(riotTimer);
  riotTimer = setTimeout(() => window.ghost.setConfig({ riotId: riotEl.value.trim() }).catch(() => {}), 500);
});

// Connect: save the ID, test the tracker link live, show exactly what happened.
const trkBtn = document.getElementById('trk-connect');
const trkStatus = document.getElementById('trk-status');
function showTrk(ok, msg) {
  trkStatus.className = `trk-status ${ok ? 'ok' : 'err'}`;
  trkStatus.textContent = msg;
  trkStatus.hidden = false;
}
trkBtn.addEventListener('click', async () => {
  trkBtn.classList.add('busy');
  trkBtn.textContent = 'Connecting';
  showTrk(true, 'Checking your tracker profile...');
  trkStatus.className = 'trk-status';
  try {
    await window.ghost.setConfig({ riotId: riotEl.value.trim() });
    const res = await window.ghost.testTracker();
    if (res && res.ok && res.stats) {
      const s = res.stats;
      const bits = [`rank ${s.rank || 'unknown'}`];
      if (s.peakRank) bits.push(`peak ${s.peakRank}`);
      if (s.kd) bits.push(`K/D ${s.kd}`);
      if (s.kpr != null) bits.push(`${s.kpr} kills/round`);
      if (s.adr) bits.push(`ADR ${s.adr}`);
      if (s.acs) bits.push(`ACS ${s.acs}`);
      if (s.headshotPct) bits.push(`HS ${s.headshotPct}%`);
      showTrk(true, `Connected. ${bits.join(', ')}. Your coach now uses all of these stats.`);
    } else {
      showTrk(false, (res && res.error) || 'Could not connect. Try again in a minute.');
    }
  } catch {
    showTrk(false, 'Could not connect. Try again in a minute.');
  } finally {
    trkBtn.classList.remove('busy');
    trkBtn.textContent = 'Connect';
  }
});

// Render the license block. Accepts either a getLicense() result or a state
// snapshot (both carry licensePlan / licenseStatus / licenseExpiry).
const ENDED_MESSAGES = {
  expired:        'Your subscription has expired. Renew to keep coaching.',
  cancelled:      'Your subscription was cancelled. Resubscribe to keep coaching.',
  payment_failed: 'Your last payment failed. Update your payment method to keep coaching.',
  device_mismatch:'This key is active on another device.',
};

function renderLicense(lic) {
  if (!lic) return;
  document.getElementById('lic-plan').textContent = lic.licensePlan || '·';
  // Reflect a lapsed subscription immediately, even before the server re-check.
  let status = lic.licenseStatus || '';
  if (lic.licenseExpiry && new Date(lic.licenseExpiry) < new Date()) status = 'expired';
  const statusEl = document.getElementById('lic-status');
  statusEl.textContent = status || '·';
  statusEl.className = `badge ${status}`;
  document.getElementById('lic-expiry').textContent = formatExpiry(lic.licenseExpiry);

  // Big red notice when the subscription is no longer active.
  const ended = !!status && status !== 'active';
  const noticeEl = document.getElementById('lic-ended');
  if (noticeEl) {
    noticeEl.textContent = ENDED_MESSAGES[status] || 'Your subscription has ended. Renew to keep coaching.';
    noticeEl.hidden = !ended;
  }
}

async function refreshLicense() {
  try { renderLicense(await window.ghost.getLicense()); } catch (e) {}
}

// Load current config + license.
async function load() {
  try {
    const cfg = await window.ghost.getConfig();
    if (cfg) {
      const fi = FREQ_ORDER.indexOf(cfg.performanceMode);
      freqEl.value = String(fi >= 0 ? fi : 1);
      freqLabel.textContent = FREQ_LABELS[fi >= 0 ? fi : 1];
      markSeg(tipposSeg, cfg.tipPosition);
      markSeg(styleSegEl, cfg.tipStyle || 'glass');
      syncOpacityAvailability(cfg.tipStyle || 'glass');
      const op = Math.round((cfg.tipOpacity != null ? cfg.tipOpacity : 0.9) * 100);
      opacityEl.value = String(op);
      opacityLabel.textContent = op + '%';
      markSeg(showTipsSeg, cfg.showTips === false ? 'off' : 'on');
      markSeg(beginnerSeg, cfg.beginnerTips === false ? 'off' : 'on');
      markSeg(aiLogSeg, cfg.aiLog === false ? 'off' : 'on');
      markSeg(voiceSeg, cfg.voiceCoach === true ? 'on' : 'off');
      markSeg(styleSeg, cfg.voiceStyle || 'normal');
      voiceSub.classList.toggle('disabled', cfg.voiceCoach !== true);
      const vv = Math.round((cfg.voiceVolume != null ? cfg.voiceVolume : 0.9) * 100);
      volEl.value = String(vv);
      volLabel.textContent = vv + '%';
      const pct = Math.round((Number(cfg.tipScale) || 1) * 100);
      scaleEl.value = String(pct);
      scaleLabel.textContent = scaleText(pct);
      if (typeof cfg.riotId === 'string') riotEl.value = cfg.riotId;
      // Already connected from a previous session? Show it, no reconnect needed.
      if (cfg.playerStats && cfg.playerStats.rank) {
        const s = cfg.playerStats;
        const bits = [`rank ${s.rank}`];
        if (s.kd) bits.push(`K/D ${s.kd}`);
        if (s.kpr != null) bits.push(`${s.kpr} kills/round`);
        if (s.adr) bits.push(`ADR ${s.adr}`);
        if (s.headshotPct) bits.push(`HS ${s.headshotPct}%`);
        showTrk(true, `Connected. ${bits.join(', ')}.`);
      }
    }
    await refreshLicense();
  } catch (err) {
    console.error('[settings] load failed', err);
  }
}

// Keep the license block consistent: on every pushed state, on window focus, and
// on a slow poll (so an expiry/renewal shows without reopening Settings).
window.ghost.onState((s) => renderLicense(s));
window.addEventListener('focus', refreshLicense);
setInterval(refreshLicense, 15000);

function formatExpiry(value) {
  if (!value) return 'Never';
  const d = new Date(value);
  return isNaN(d) ? value : d.toLocaleDateString();
}

document.getElementById('purchase').addEventListener('click', () => window.ghost.openPurchase());
document.getElementById('logout').addEventListener('click', () => window.ghost.logout());
document.getElementById('quit').addEventListener('click', () => window.ghost.quit());
document.getElementById('close').addEventListener('click', () => window.close());

// Support email: click to copy to clipboard (falls back to selecting the text).
const emailEl = document.getElementById('support-email');
if (emailEl) {
  emailEl.addEventListener('click', () => {
    const email = 'ghostcoachsupport@gmail.com';
    const flash = () => {
      const orig = emailEl.textContent;
      emailEl.textContent = 'Copied!';
      emailEl.classList.add('copied');
      setTimeout(() => { emailEl.textContent = orig; emailEl.classList.remove('copied'); }, 1200);
    };
    const selectIt = () => {
      const r = document.createRange(); r.selectNodeContents(emailEl);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(email).then(flash).catch(selectIt);
      } else selectIt();
    } catch { selectIt(); }
  });
}

load();
console.log('[settings] ready');
