'use strict';

/**
 * The health a player died with is not health they still have.
 *
 * When a player dies, the server strips the health number before it is sent,
 * because the number on screen now belongs to the spectated teammate (see
 * test-alive-claims). The client merge then skipped the absent field and left
 * the player's LAST-ALIVE health sitting in match context.
 *
 * That number is not inert. The server decides whether to coach a living player
 * with `alive === true || hp > 0`, so a context of { playerAlive: false,
 * playerHp: 100 } resolves to ALIVE, and the prompt told the model:
 *
 *   "THE PLAYER IS ALIVE RIGHT NOW, at 100 HP, and is playing this round.
 *    Do NOT review a death..."
 *
 * while the player sat watching a killcam. Every deliberate guard downstream is
 * built on the client and the server agreeing about whether the player is
 * breathing, and this quietly broke that agreement on every frame after a death.
 *
 * Run: npm run test:deathhp
 */
const path = require('path');
const CoachingEngine = require(path.join(__dirname, '..', 'src', 'main', 'services', 'coaching-engine.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// The exact test the server applies to decide if it is coaching a live player.
const serverSeesAlive = (ctx) => ctx.playerAlive === true
  || (typeof ctx.playerHp === 'number' && ctx.playerHp > 0);

function alivePlayer() {
  const e = new CoachingEngine({});
  e.updateMatchContext({ phase: 'active', playerAlive: true, playerHp: 100, playerWeapon: 'Vandal', roundNumber: 4 });
  return e;
}

console.log('alive and being read normally:');
{
  const e = alivePlayer();
  check('  health is merged', e.matchContext.playerHp === 100);
  check('  the server sees a live player', serverSeesAlive(e.matchContext) === true);
}

console.log('\nthe frame the death lands on (health absent, dead tell named):');
{
  const e = alivePlayer();
  e.updateMatchContext({ playerAlive: false, aliveTell: 'SWITCH PLAYER prompt bottom left, killcam playing' });
  check('  the death registered', e.matchContext.playerAlive === false, 'a proven tell needs only one frame');
  check('  health was cleared', e.matchContext.playerHp == null,
    `still ${e.matchContext.playerHp}`);
  check('  THE SERVER NO LONGER SEES A LIVE PLAYER', serverSeesAlive(e.matchContext) === false,
    'this is the assertion the whole file exists for');
}

console.log('\nthe frames after it, showing the spectated teammate at full health:');
{
  const e = alivePlayer();
  e.updateMatchContext({ playerAlive: false, aliveTell: 'killcam playing, KILLED BY panel' });
  // Valorant shows the spectated teammate's HUD in the same slots. If a frame
  // does report a number, it is theirs, so it must not be adopted.
  e.updateMatchContext({ phase: 'dead', playerHp: 100, playerWeapon: 'Operator', playerCredits: 3200 });
  check('  a spectated health number is not adopted', e.matchContext.playerHp == null,
    `adopted ${e.matchContext.playerHp}`);
  check('  the spectated weapon is still ignored too', e.matchContext.playerWeapon === 'Vandal',
    `became ${e.matchContext.playerWeapon}`);
  check('  the server still sees a dead player', serverSeesAlive(e.matchContext) === false);
}

console.log('\nrespawning takes their own health back:');
{
  const e = alivePlayer();
  e.updateMatchContext({ playerAlive: false, aliveTell: 'spectating teammate, killcam playing' });

  // The respawn frame itself still reads as spectating, because the guard asks
  // what the context says and the context is only updated by the merge it
  // guards. Every spectator-owned field lags by exactly one frame this way, so
  // health lagging with them is the consistent behaviour, not a new quirk.
  e.updateMatchContext({ phase: 'buy', playerAlive: true, playerHp: 100, playerWeapon: 'Classic' });
  check('  alive again immediately', e.matchContext.playerAlive === true);
  check('  the server sees a live player again', serverSeesAlive(e.matchContext) === true,
    'this is what actually matters, and playerAlive carries it on its own');
  check('  health lags one frame, exactly like the weapon does',
    e.matchContext.playerHp == null && e.matchContext.playerWeapon === 'Vandal',
    `hp=${e.matchContext.playerHp} weapon=${e.matchContext.playerWeapon}`);

  e.updateMatchContext({ phase: 'buy', playerAlive: true, playerHp: 100, playerWeapon: 'Classic' });
  check('  and both read again on the next frame',
    e.matchContext.playerHp === 100 && e.matchContext.playerWeapon === 'Classic',
    `hp=${e.matchContext.playerHp} weapon=${e.matchContext.playerWeapon}`);
}

console.log('\nHP STILL BEATS DEATH, which must not regress:');
{
  const e = alivePlayer();
  // A hallucinated dead tell alongside a readable health number is the case the
  // engine deliberately overrides: the number is ground truth.
  e.updateMatchContext({ playerAlive: false, playerHp: 87, aliveTell: 'spectating a teammate' });
  check('  a dead read with readable health is refused', e.matchContext.playerAlive === true,
    'the health number is the ground truth for being alive');
  check('  and that health is kept', e.matchContext.playerHp === 87,
    `got ${e.matchContext.playerHp}`);
  check('  the server sees a live player', serverSeesAlive(e.matchContext) === true);
}

console.log('\nan unproven dead read still waits for a second frame:');
{
  const e = alivePlayer();
  e.updateMatchContext({ playerAlive: false });          // no tell, no health: unproven
  check('  one bare alive:false does not kill the player', e.matchContext.playerAlive === true);
  check('  and health is untouched', e.matchContext.playerHp === 100,
    `got ${e.matchContext.playerHp}`);
  e.updateMatchContext({ playerAlive: false });          // second agreeing read
  check('  two agreeing reads do', e.matchContext.playerAlive === false);
  check('  and then health is cleared', e.matchContext.playerHp == null,
    `got ${e.matchContext.playerHp}`);
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
