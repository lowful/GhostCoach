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
  if (index === pages.length - 1) window.ghost.done();
  else go(index + 1);
});

document.getElementById('close').addEventListener('click', () => window.ghost.done());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.ghost.done();
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

wireSeg(document.getElementById('fundamentals'), (v) => window.ghost.setFundamentals(v === 'on'));
wireSeg(document.getElementById('tipstyle'),     (v) => window.ghost.setConfig({ tipStyle: v }).catch(() => {}));

const opacityEl    = document.getElementById('tipopacity');
const opacityLabel = document.getElementById('tipopacity-label');
opacityEl.addEventListener('input', () => { opacityLabel.textContent = opacityEl.value + '%'; });
opacityEl.addEventListener('change', () => {
  window.ghost.setConfig({ tipOpacity: Number(opacityEl.value) / 100 }).catch(() => {});
});

// Reflect whatever is already saved, so re-running the tour never silently
// resets a choice the player made in Settings.
window.ghost.getConfig().then((cfg) => {
  if (!cfg) return;
  const style = cfg.tipStyle || 'glass';
  for (const b of document.getElementById('tipstyle').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.val === style);
  }
  const op = Math.round((cfg.tipOpacity != null ? cfg.tipOpacity : 0.9) * 100);
  opacityEl.value = String(op);
  opacityLabel.textContent = op + '%';
  for (const b of document.getElementById('fundamentals').querySelectorAll('button')) {
    b.classList.toggle('active', (b.dataset.val === 'on') === (cfg.beginnerTips !== false));
  }
}).catch(() => {});

go(0);
console.log('[onboarding] ready');
