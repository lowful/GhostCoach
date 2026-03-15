(function() {
  'use strict';

  const input  = document.getElementById('license-key-input');
  const btn    = document.getElementById('btn-activate');
  const errMsg = document.getElementById('error-msg');
  const purchaseLink = document.getElementById('link-purchase');
  const btnQuit = document.getElementById('btn-quit');

  // Format input as GC-XXXX-XXXX-XXXX-XXXX while typing
  input.addEventListener('input', () => {
    let val = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Strip leading GC prefix so we can re-add it cleanly
    if (val.startsWith('GC')) val = val.slice(2);
    // Split into segments of 4
    let parts = [];
    for (let i = 0; i < val.length && parts.length < 4; i += 4) {
      parts.push(val.slice(i, i + 4));
    }
    const formatted = 'GC-' + parts.join('-');
    input.value = formatted;
    btn.disabled = !isValidFormat(input.value);
    errMsg.classList.add('hidden');
    errMsg.textContent = '';
  });

  function isValidFormat(val) {
    return /^GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(val);
  }

  btn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!isValidFormat(key)) return;

    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'VALIDATING...';
    errMsg.classList.add('hidden');

    try {
      const result = await window.activateAPI.validateKey(key);
      if (result.valid) {
        btn.querySelector('.btn-text').textContent = 'ACTIVATED!';
        // Main process will close this window and proceed
      } else {
        errMsg.textContent = result.error || 'Invalid license key';
        errMsg.classList.remove('hidden');
        btn.disabled = false;
        btn.querySelector('.btn-text').textContent = 'ACTIVATE';
      }
    } catch (err) {
      errMsg.textContent = 'Could not connect to server. Check your internet connection.';
      errMsg.classList.remove('hidden');
      btn.disabled = false;
      btn.querySelector('.btn-text').textContent = 'ACTIVATE';
    }
  });

  if (purchaseLink) {
    purchaseLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.activateAPI.openPurchase();
    });
  }

  if (btnQuit) {
    btnQuit.addEventListener('click', () => window.activateAPI.quit());
  }
})();
