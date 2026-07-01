'use strict';

const form     = document.getElementById('form');
const keyInput = document.getElementById('key');
const button   = document.getElementById('activate');
const spinner  = button.querySelector('.spinner');
const check    = button.querySelector('.check');
const errorBox = document.getElementById('error');

keyInput.focus();

function showError(msg) {
  errorBox.classList.remove('notice');
  errorBox.textContent = msg;
  errorBox.hidden = false;
  // restart shake animation
  errorBox.style.animation = 'none';
  void errorBox.offsetWidth;
  errorBox.style.animation = '';
}
function clearError() { errorBox.hidden = true; errorBox.classList.remove('notice'); }

// A neutral (non-error) notice, e.g. shown after logout or when a subscription
// runs out. Passed in via the ?notice= query when the window is opened.
function showNotice(msg) {
  errorBox.classList.add('notice');
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
const notice = new URLSearchParams(location.search).get('notice');
if (notice) showNotice(notice);

function setState(stateName) {
  button.classList.toggle('loading', stateName === 'loading');
  button.classList.toggle('success', stateName === 'success');
  spinner.hidden = stateName !== 'loading';
  check.hidden   = stateName !== 'success';
  const busy = stateName === 'loading' || stateName === 'success';
  button.disabled = busy;
  keyInput.disabled = busy;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const key = keyInput.value.trim();
  if (!key) { showError('Enter your license key.'); return; }

  setState('loading');
  try {
    const result = await window.ghost.activate(key);
    if (result && result.valid) {
      setState('success'); // main process closes this window and launches the app
      return;
    }
    setState('idle');
    showError((result && result.error) || 'That key could not be activated.');
  } catch (err) {
    setState('idle');
    showError('Something went wrong. Please try again.');
  }
});

// Normalize key entry: uppercase and strip stray characters, without fighting
// the caret (only rewrites when the cursor is at the end).
keyInput.addEventListener('input', () => {
  const caretAtEnd = keyInput.selectionStart === keyInput.value.length;
  const normalized = keyInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (caretAtEnd && normalized !== keyInput.value) keyInput.value = normalized;
});

document.getElementById('purchase').addEventListener('click', () => window.ghost.openPurchase());
document.getElementById('close').addEventListener('click', () => window.ghost.quit());
