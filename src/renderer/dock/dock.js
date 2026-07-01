'use strict';

const dot = document.getElementById('dot');

window.ghost.onStatus(({ status }) => {
  dot.className = `dot ${status === 'coaching' ? 'coaching' : status === 'paused' ? 'paused' : ''}`;
});

console.log('[dock] ready');
