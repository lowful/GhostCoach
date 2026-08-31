'use strict';

/**
 * Welcome tour. Four short pages instead of one long list, because the old
 * single card asked the player to read five numbered steps and a settings
 * question before they could get to a match.
 *
 * Every choice saves the moment it is made, so closing the tour at any point
 * (button, ✕, Esc) keeps whatever was picked.
 */

const pages   = [...document.querySelectorAll('.page')];
const dotsEl  = document.getElementById('dots');
const backBtn = document.getElementById('back');
const nextBtn = document.getElementById('next');
let index = 0;

// Progress dots, clickable so the tour can be skimmed in either direction.
const dots = pages.map((_, i) => {
  const d = document.createElement('button');
  d.className = 'dot-nav';
  d.type = 'button';
  d.title = `Step ${i + 1}`;
  d.addEventListener('click', () => go(i));
  dotsEl.append(d);
  return d;
});

function go(next) {
  index = Math.max(0, Math.min(pages.length - 1, next));
  pages.forEach((p, i) => { p.hidden = i !== index; });
  dots.forEach((d, i) => {
    d.classList.toggle('active', i === index);
    d.classList.toggle('done', i < index);
  });
  backBtn.style.visibility = index === 0 ? 'hidden' : 'visible';
  // The last page finishes the tour rather than going nowhere.
  nextBtn.textContent = index === pages.length - 1 ? "Let's go" : 'Next';
}

backBtn.addEventListener('click', () => go(index - 1));
nextBtn.addEventListener('click', () => {
  if (index === pages.length - 1) window.occlara.done();
  else go(index + 1);
});

document.getElementById('close').addEventListener('click', () => window.occlara.done());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.occlara.done();
  else if (e.key === 'Enter' || e.key === 'ArrowRight') nextBtn.click();
  else if (e.key === 'ArrowLeft') backBtn.click();
});

// ── Choices (each saves immediately) ────────────────────────────────────────

function wireSeg(seg, onPick) {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', b === btn);
    onPick(btn.dataset.val);
  });
}

wireSeg(document.getElementById('fundamentals'), (v) => window.occlara.setFundamentals(v === 'on'));
wireSeg(document.getElementById('tipstyle'), (v) => {
  window.occlara.setConfig({ tipStyle: v }).catch(() => {});
  syncOpacityAvailability(v);
});

const opacityEl    = document.getElementById('tipopacity');
const opacityLabel = document.getElementById('tipopacity-label');

// Minimal has no card behind the text, so there is nothing to fade. Disable
// the slider rather than leave one that does nothing.
function syncOpacityAvailability(style) {
  const off = style === 'minimal';
  opacityEl.disabled = off;
  const row = opacityEl.closest('.op-row');
  if (row) row.classList.toggle('disabled', off);
}
opacityEl.addEventListener('input', () => { opacityLabel.textContent = opacityEl.value + '%'; });
opacityEl.addEventListener('change', () => {
  window.occlara.setConfig({ tipOpacity: Number(opacityEl.value) / 100 }).catch(() => {});
});

// Reflect whatever is already saved, so re-running the tour never silently
// resets a choice the player made in Settings.
window.occlara.getConfig().then((cfg) => {
  if (!cfg) return;
  const style = cfg.tipStyle || 'glass';
  for (const b of document.getElementById('tipstyle').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.val === style);
  }
  syncOpacityAvailability(style);
  const op = Math.round((cfg.tipOpacity != null ? cfg.tipOpacity : 0.9) * 100);
  opacityEl.value = String(op);
  opacityLabel.textContent = op + '%';
  for (const b of document.getElementById('fundamentals').querySelectorAll('button')) {
    b.classList.toggle('active', (b.dataset.val === 'on') === (cfg.beginnerTips !== false));
  }
}).catch(() => {});


// ── Language ────────────────────────────────────────────────────────────────
// Chosen on page one, so the rest of onboarding and every coaching tip that
// follows arrive in the player's language rather than being switched later.
const obLang = document.getElementById('ob-language');
const obLangNote = document.getElementById('ob-language-note');

function obShowNote(code) {
  if (!obLangNote || !window.occlara.i18n) return;
  const translated = window.occlara.i18n.hasUi(code);
  obLangNote.hidden = translated;
  if (!translated) {
    obLangNote.textContent =
      'Coaching tips will be in this language. The app’s own buttons stay English for now.';
  }
}

if (obLang && window.occlara.i18n && window.Dropdown) {
  // The app's own dropdown, not a native <select>. This is the very first
  // screen a new player sees, and on Windows the native control drew a white
  // box in the middle of the dark card: the most obviously foreign thing in
  // the whole interface, on first run.
  window.occlara.getConfig().then((cfg) => {
    const current = (cfg && cfg.language) || 'en';
    window.Dropdown.create(obLang, {
      label: 'Language',
      value: current,
      options: window.occlara.i18n.languages().map((l) => ({
        value: l.code,
        label: l.name,
        tag: window.occlara.i18n.hasUi(l.code) ? '' : 'tips only',
      })),
      onChange: async (code) => {
        await window.occlara.setConfig({ language: code });
        obShowNote(code);
        if (window.initI18n) window.initI18n();
      },
    });
    obShowNote(current);
  }).catch(() => {});
}

if (window.initI18n) window.initI18n().catch(() => {});

go(0);
console.log('[onboarding] ready');
