'use strict';

/**
 * English is full of agent names, and the detector was a substring search.
 *
 *     validAgents.find(a => cleanText.toLowerCase().includes(a.toLowerCase()))
 *
 * So the model saying it could not tell was read as a positive identification:
 *
 *     "the icons are not visible at this moment"      -> OMEN     (m-OMEN-t)
 *     "cannot read the ability bar in this isolation" -> ISO       (ISO-lation)
 *     "please check the message area"                 -> SAGE      (mes-SAGE)
 *
 * A wrong lock is expensive. The ability gate validates every tip against the
 * locked agent's kit, so identifying Omen for a Jett player both green-lights
 * smoke advice they cannot follow and blocks the dash advice they can. Returning
 * null costs only the confirmation bubble the flow shows anyway.
 *
 * The refusals are the substance of this file: ambiguity and prose must both
 * resolve to null rather than to a guess.
 *
 * Run: npm run test:agentdetect
 */
const path = require('path');

// coach.js builds a Supabase client at import time; detectAgentName never uses it.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key-not-used';

const { detectAgentName } = require(path.join(__dirname, '..', 'server', 'routes', 'coach.js'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

console.log('THE FALSE POSITIVES THAT SHIPPED, every one of these must be null:');
for (const [reply, wrongly] of [
  ['The icons are not visible at this moment', 'Omen'],
  ['Cannot read the ability bar in this isolation view', 'Iso'],
  ['Please check the message area', 'Sage'],
  ['I am not sure, the phoenix-like flames are unclear', 'Phoenix'],
  ['The moment the round starts I could tell', 'Omen'],
]) {
  check(`  "${reply.slice(0, 48)}" (was ${wrongly})`, detectAgentName(reply), null);
}

console.log('\nthe answer the prompt actually asks for:');
for (const a of ['Jett', 'Omen', 'Iso', 'Sage', 'Phoenix', 'KAY/O', 'Waylay', 'Tejo']) {
  check(`  "${a}"`, detectAgentName(a), a);
}

console.log('\ncase and stray punctuation do not matter:');
check('  "jett"',      detectAgentName('jett'), 'Jett');
check('  "KILLJOY"',   detectAgentName('KILLJOY'), 'Killjoy');
check('  "Jett."',     detectAgentName('Jett.'), 'Jett');
check('  "  Omen  "',  detectAgentName('  Omen  '), 'Omen');
check('  "Sova!"',     detectAgentName('Sova!'), 'Sova');

console.log('\nKAY/O survives the spellings a model reaches for:');
check('  "KAYO"',      detectAgentName('KAYO'), 'KAY/O');
check('  "KAY-O"',     detectAgentName('KAY-O'), 'KAY/O');
check('  "Kay O"',     detectAgentName('Kay O'), 'KAY/O');

console.log('\na short answer that still names one agent is accepted:');
check('  "Agent: Jett"',   detectAgentName('Agent: Jett'), 'Jett');
check('  "It is Jett"',    detectAgentName('It is Jett'), 'Jett');
check('  "Jett (Duelist)"', detectAgentName('Jett (Duelist)'), 'Jett');

console.log('\nthe refusals:');
check('  "UNKNOWN"',          detectAgentName('UNKNOWN'), null);
check('  empty',              detectAgentName(''), null);
check('  null',               detectAgentName(null), null);
check('  undefined',          detectAgentName(undefined), null);
check('  two agents named',   detectAgentName('Jett or Reyna'), null);
check('  a whole sentence',   detectAgentName('The agent appears to be Jett based on the four ability icons'), null);
check('  a non-agent word',   detectAgentName('Duelist'), null);
check('  a refusal sentence', detectAgentName('I cannot determine the agent from this frame'), null);

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
