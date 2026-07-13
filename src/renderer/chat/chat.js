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

// "Ask Coach about this" from the stats dashboard: a pending session seed is
// auto-sent as the opening question so the AI speaks to that exact session.
// Checked on load and on focus (covers the chat already being open); the seed
// clears on read so it fires once.
async function checkSeed() {
  try {
    const seed = await window.ghost.getSeed();
    if (!seed || busy) return;
    const sc = seed.scores || {};
    const parts = [`Review my coached session${seed.date ? ' from ' + seed.date : ''}${seed.map ? ' on ' + seed.map : ''}.`];
    if (sc.economy != null) parts.push(`Category scores, Economy ${sc.economy}, Positioning ${sc.positioning}, Utility ${sc.utility}, Aim ${sc.aim}${seed.overall != null ? ', overall ' + seed.overall : ''}.`);
    if (seed.strengths)  parts.push(`Strengths noted: ${seed.strengths}`);
    if (seed.weaknesses) parts.push(`Weaknesses noted: ${seed.weaknesses}`);
    parts.push('What should I focus on first?');
    send(parts.join(' '));
  } catch {}
}
window.addEventListener('focus', () => { checkSeed(); });
checkSeed();

document.getElementById('close').addEventListener('click', () => window.close());
inputEl.focus();
console.log('[chat] ready');
