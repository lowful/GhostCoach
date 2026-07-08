'use strict';

const perfSeg   = document.getElementById('perf');
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

wireSeg(perfSeg, 'performanceMode');
wireSeg(tipposSeg, 'tipPosition');

const capqSeg = document.getElementById('capq');
wireSeg(capqSeg, 'captureQuality');

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
      if (s.kd) bits.push(`K/D ${s.kd}`);
      if (s.headshotPct) bits.push(`HS ${s.headshotPct}%`);
      showTrk(true, `Connected. ${bits.join(', ')}. Your coach now uses these stats.`);
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
      markSeg(perfSeg, cfg.performanceMode);
      markSeg(tipposSeg, cfg.tipPosition);
      markSeg(capqSeg, cfg.captureQuality || 'standard');
      const pct = Math.round((Number(cfg.tipScale) || 1) * 100);
      scaleEl.value = String(pct);
      scaleLabel.textContent = scaleText(pct);
      if (typeof cfg.riotId === 'string') riotEl.value = cfg.riotId;
      // Already connected from a previous session? Show it, no reconnect needed.
      if (cfg.playerStats && cfg.playerStats.rank) {
        const s = cfg.playerStats;
        const bits = [`rank ${s.rank}`];
        if (s.kd) bits.push(`K/D ${s.kd}`);
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
