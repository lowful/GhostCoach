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
  if (opts.shot) {
    const note = document.createElement('span');
    note.className = 'shot-note';
    note.textContent = '📸 sent with a screenshot of your screen';
    el.append(note);
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

async function send(text, withScreenshot) {
  if (busy) return;
  text = (text || '').trim();
  if (!text) return;

  busy = true;
  sendBtn.disabled = true;
  inputEl.value = '';

  addMsg('user', text, { shot: !!withScreenshot });
  history.push({ role: 'user', content: text });

  const typing = showTyping();
  try {
    const res = await window.ghost.sendChat(history.slice(-12), { withScreenshot: !!withScreenshot });
    typing.remove();
    if (res && res.ok && res.reply) {
      addMsg('assistant', res.reply);
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

composer.addEventListener('submit', (e) => { e.preventDefault(); send(inputEl.value, false); });

for (const btn of document.querySelectorAll('.starter')) {
  btn.addEventListener('click', () => {
    const withShot = btn.dataset.shot === '1';
    const text = withShot
      ? 'Look at my screen right now. What did I do badly this game, and what did I do well?'
      : btn.textContent.replace(/\s+/g, ' ').replace(/Reads your screen/i, '').trim();
    send(text, withShot);
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
