'use strict';

/**
 * The coach must know the kit of the agent actually being played.
 *
 * The prompt used to carry a hand-written roster that described abilities as
 * vague categories ("Iso: shield, wall") and openly gave up on newer agents,
 * instructing the model to guess for Vyse, Tejo and Waylay. Meanwhile the
 * client's ability gate validates tips against the REAL ability names in
 * valorant-data.generated.json, so the prompt was teaching a vocabulary the gate
 * then rejected. One Iso session lost 7 tips to ability rejections.
 *
 * This is the kind of context worth adding: an agent's kit never changes, is not
 * legible on screen, and the model has no way to check itself. Adding more
 * VOLATILE state does the opposite, the model starts answering from the context
 * instead of the frame.
 *
 * Run: npm run test:agentkit
 */
const path = require('path');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key-not-used';

const DATA = require(path.join(__dirname, '..', 'server', 'valorant-data.generated.json'));
const AGENTS = DATA.agents || {};
const clientAgents = require(path.join(__dirname, '..', 'src', 'main', 'services', 'agent-data.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

console.log('the roster covers every agent, including the ones the old list refused:');
for (const n of ['Iso', 'Vyse', 'Tejo', 'Waylay', 'Jett', 'Sage']) {
  const a = AGENTS[n];
  check(`  ${n.padEnd(7)} ${a ? `${a.role}: ${a.abilities.join(', ')}` : 'MISSING'}`,
    !!(a && a.role && a.abilities && a.abilities.length >= 3));
}

console.log('\nevery agent has a role the prompt can brief:');
const ROLES = new Set(['Duelist', 'Controller', 'Initiator', 'Sentinel']);
const badRole = Object.entries(AGENTS).filter(([, a]) => !ROLES.has(a.role));
check(`  all ${Object.keys(AGENTS).length} agents`, badRole.length === 0,
  `no brief for: ${badRole.map(([n, a]) => `${n} (${a.role})`).join(', ')}`);

console.log('\nTHE POINT OF THE FIX: the prompt and the ability gate now agree.');
// The gate validates a tip's ability names against this list, so anything the
// prompt teaches must appear in it or the tip is rejected after being written.
for (const n of ['Iso', 'Jett', 'Sage', 'Tejo']) {
  const promptNames = (AGENTS[n].abilities || []).map((s) => s.toLowerCase());
  const gateNames = (clientAgents.getAbilities(n) || []).map((s) => String(s).toLowerCase());
  const shared = promptNames.filter((a) => gateNames.includes(a));
  check(`  ${n.padEnd(7)} ${shared.length}/${promptNames.length} of the taught names pass the gate`,
    shared.length === promptNames.length,
    `taught but rejected: ${promptNames.filter((a) => !gateNames.includes(a)).join(', ')}`);
}

console.log('\nan unconfirmed agent still gets no ability vocabulary at all:');
check('  no agent record means no kit to teach', !AGENTS[''] && !AGENTS['Unknown']);

// The blocks have to actually reach the prompt. A knowledge source that is
// computed, stored and never interpolated is exactly the bug being fixed here:
// the habit profile existed for the weekly report for weeks without the live
// coach ever seeing it.
const { buildContextPrompt } = require(path.join(__dirname, '..', 'server', 'routes', 'coach.js'));

console.log('\nthe kit reaches the prompt, with the real names:');
const withAgent = buildContextPrompt({ agent: 'Iso', agentConfirmed: true, map: 'Breeze', phase: 'active' });
check('  the confirmed agent\'s abilities are named', /undercut/.test(withAgent) && /contingency/.test(withAgent));
check('  the role is briefed, not just labelled', /Duelist, the one who takes space/.test(withAgent));
check('  no other agent\'s kit is dragged along',
  !/tailwind|healing orb|guided salvo/.test(withAgent),
  'the prompt still carries a full roster');

const noAgent = buildContextPrompt({ map: 'Breeze', phase: 'active' });
check('  an unknown agent is told to name nothing', /name NO ability at all/.test(noAgent));

console.log('\nthe habit profile reaches the prompt:');
const habits = [{ id: 'overextend', label: 'Over-extending alone', sessions: 3, count: 9,
  fix: 'Glance at the minimap before you take space.' }];
const withHabits = buildContextPrompt({ map: 'Breeze', phase: 'active', habits });
check('  the habit and its fix are included',
  /Over-extending alone/.test(withHabits) && /Glance at the minimap/.test(withHabits));
check('  it says when it was seen', /seen in 3 sessions/.test(withHabits));
check('  the coach is told to watch, not recite', /Do NOT recite them as a list/.test(withHabits));
check('  no habits means no block', !/WHAT THIS PLAYER KEEPS DOING WRONG/.test(noAgent));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
