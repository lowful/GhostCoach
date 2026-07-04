'use strict';

document.getElementById('go').addEventListener('click', () => window.ghost.done());
document.getElementById('close').addEventListener('click', () => window.ghost.done());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter') window.ghost.done();
});

console.log('[onboarding] ready');
