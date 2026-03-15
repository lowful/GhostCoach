(function () {
  const input         = document.getElementById('api-key-input');
  const btnSave       = document.getElementById('btn-save');
  const btnToggle     = document.getElementById('btn-toggle-visibility');
  const errorMsg      = document.getElementById('error-msg');
  const linkAnthropic = document.getElementById('link-anthropic');
  const btnClose      = document.getElementById('btn-close');

  let showKey = false;

  btnClose.addEventListener('click', () => window.close());

  // Enable save button when input has a plausible key
  input.addEventListener('input', () => {
    const val = input.value.trim();
    btnSave.disabled = val.length < 20;
    errorMsg.classList.add('hidden');
  });

  // Toggle visibility
  btnToggle.addEventListener('click', () => {
    showKey = !showKey;
    input.type = showKey ? 'text' : 'password';
    btnToggle.textContent = showKey ? '🙈' : '👁';
  });

  // Save key
  btnSave.addEventListener('click', () => {
    const key = input.value.trim();

    if (!key.startsWith('sk-ant-')) {
      errorMsg.textContent = 'Key should start with sk-ant-… — please double-check and try again.';
      errorMsg.classList.remove('hidden');
      return;
    }

    btnSave.disabled = true;
    btnSave.querySelector('span:last-child').textContent = 'LAUNCHING…';

    if (window.setupAPI) {
      window.setupAPI.saveApiKey(key);
    }
  });

  // Open Anthropic console in default browser
  linkAnthropic.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.setupAPI) {
      window.setupAPI.openExternal('https://console.anthropic.com/');
    }
  });

  // Focus input on load
  input.focus();
})();
