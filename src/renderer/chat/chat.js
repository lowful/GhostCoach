'use strict';

const threadEl = document.getElementById('thread');
const introEl  = document.getElementById('intro');
const composer = document.getElementById('composer');
const inputEl  = document.getElementById('input');
const sendBtn  = document.getElementById('send');
const agentChip = document.getElementById('agent-chip');

const history = [];   // { role: 'user'|'assistant', content }
let busy = false;

function addMsg(role, text, opts = {}) {
  introEl.hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${role === 'user' ? 'user' : 'coach'}${opts.error ? ' error' : ''}`;
  el.textContent = text;
  if (opts.shotData) {
    // The frame from the player's recorded gameplay the coach is referring to.
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = 'data:image/jpeg;base64,' + opts.shotData;
    img.alt = 'frame from your recorded gameplay';
    img.addEventListener('click', () => img.classList.toggle('zoomed'));
    el.append(img);
    const cap = document.createElement('span');
    cap.className = 'shot-caption';
    cap.textContent = 'from your recorded gameplay';
    el.append(cap);
  }
  threadEl.append(el);
  threadEl.scrollTop = threadEl.scrollHeight;
  return el;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'typing';
  el.innerHTML = '<i></i><i></i><i></i>';
  threadEl.append(el);
  threadEl.scrollTop = threadEl.scrollHeight;
  return el;
}

async function send(text) {
  if (busy) return;
  text = (text || '').trim();
  if (!text) return;

  busy = true;
  sendBtn.disabled = true;
  inputEl.value = '';

  addMsg('user', text);
  history.push({ role: 'user', content: text });

  const typing = showTyping();
  try {
    const res = await window.ghost.sendChat(history.slice(-12));
    typing.remove();
    if (res && res.ok && res.reply) {
      // When the coach referenced a frame from the player's recorded gameplay,
      // it comes back with the reply so the player can see what it means.
      addMsg('assistant', res.reply, res.image ? { shotData: res.image } : {});
      history.push({ role: 'assistant', content: res.reply });
    } else {
      addMsg('assistant', (res && res.error) || 'Could not reach your coach right now. Try again in a moment.', { error: true });
    }
  } catch {
    typing.remove();
    addMsg('assistant', 'Could not reach your coach right now. Try again in a moment.', { error: true });
  } finally {
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

composer.addEventListener('submit', (e) => { e.preventDefault(); send(inputEl.value); });

for (const btn of document.querySelectorAll('.starter')) {
  btn.addEventListener('click', () => {
    send(btn.textContent.replace(/\s+/g, ' ').trim());
  });
}

// Agent chip in the header for context.
function applyState(s) {
  if (s && s.agent && s.agent.agent) {
    agentChip.textContent = s.agent.agent;
    agentChip.hidden = false;
  }
}
window.ghost.getState().then(applyState).catch(() => {});
window.ghost.onState(applyState);

document.getElementById('close').addEventListener('click', () => window.close());
inputEl.focus();
console.log('[chat] ready');
