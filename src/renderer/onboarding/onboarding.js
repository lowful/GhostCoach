'use strict';

document.getElementById('go').addEventListener('click', () => window.ghost.done());
document.getElementById('close').addEventListener('click', () => window.ghost.done());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter') window.ghost.done();
});

// Fundamental tips question: the choice saves immediately, so closing the card
// any way (button, ✕, Esc) keeps whatever the player picked. Default is on,
// which suits new players and Silver and below; higher ranks tap Off.
const fundamentalsSeg = document.getElementById('fundamentals');
fundamentalsSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  for (const b of fundamentalsSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b === btn);
  }
  window.ghost.setFundamentals(btn.dataset.val === 'on');
});

console.log('[onboarding] ready');
