'use strict';

/**
 * Large, situation-aware fallback library of Radiant / pro-level Valorant
 * tactics, written in casual, in-game lingo. Shown during AI silence/SKIP and
 * whenever the server is unreachable, so the overlay always delivers value.
 *
 * The selector reads match context (phase, economy, side, streaks, round) to
 * pick a bucket and returns a tip not in the recent history. Buy advice only
 * fires when the round AND credits are clearly known. Pure client-side.
 */

const LIBRARY = {
  // ── Economy / buy phase (specific "what to buy" advice) ─────────────────────
  pistol: [
    'Pistol round, grab light shields and util, save the rest for round two.',
    'Don’t hold your abilities, you can’t carry them over. Dump util on the exec.',
    'Win it with crossfires and trades, tap heads, don’t spray and pray.',
    'On D, stack a site and play for picks. Don’t go hunting solo.',
    'Plant for the bonus even if you trade, round two’s buy decides the half.',
    'Light shields are huge on pistols, that extra HP wins close fights.',
    'Take it slow as five on attack, don’t split off and get picked.',
    'Classic right-click melts up close, don’t sleep on it pistol round.',
    'Play for the 2v1s on pistol, one clean trade usually wins it.',
  ],
  eco: [
    'Eco, save it, full stop. Don’t blow credits on a Sheriff and tank next buy.',
    'Stack a site and try to jack a rifle off one pick.',
    'Play tight angles, drag ’em into close fights where pistols win.',
    'Grab free map control and info, then bail, don’t feed the round.',
    'If you’re light-buying, do it as a team or not at all.',
    'Save fully so next round you can full-buy with the squad.',
    'On eco, play for exit frags late, don’t fight their opening push.',
    'Group up on eco, five pistols in one choke actually wins rounds.',
  ],
  forcebuy: [
    'Force? Spectre or Bulldog + light shields, but only if the team buys too.',
    'Forcing means getting close, SMGs and shotties shred rifles up tight.',
    'Push for early picks before they set crossfires, speed’s your edge.',
    'Don’t solo-force, you’ll just donate your gun. Commit as five.',
    'Marshal + util can out-range them on a force if you hold long.',
    'On a force, hit one site fast before their util comes online.',
    'Sheriff on a force rewards clean heads, commit to the tap.',
  ],
  fullbuy: [
    'Full buy, Vandal or Phantom, full shields, all your util. Play patient.',
    'You’ve got the kit, use util to enter, don’t dry-swing into crossfires.',
    'Stay in trade range, no free deaths on a full buy.',
    'Default first, take map control, then commit as five.',
    'Loaded? Grab the Op if you can hold a long angle for the team.',
    'Save a piece of util for the post-plant or retake, don’t dump it all.',
    'Full buy means patience, you win by trading, not by rushing timers.',
    'Drop a teammate a rifle if you’re rich, five guns beat four.',
  ],

  // ── Round phases ─────────────────────────────────────────────────────────────
  postplant: [
    'Spike’s down, play the timer, don’t go peeking. Let them come to you.',
    'Hold a wide off-angle so they can’t trade you on the retake.',
    'Watch the default plant spot from range, you’ve got all the time.',
    'Split around the spike so one util can’t clear you both.',
    'Save a molly or smoke to deny the defuse at the end.',
    'Crossfire the bomb, one close, one far, and trade the defuser.',
    'Don’t peek the retake, make ’em swing into your crosshair.',
    'Count the timer out loud, at 7 seconds a tap can’t finish.',
    'Reposition after every kill post-plant, they know where you shot from.',
  ],
  retake: [
    'Retake together, not one-by-one, group up and trade the entry.',
    'Clear the common post-plant spots with util before you swing.',
    'Smoke the spike for a safer defuse if you’ve got it.',
    'Get info first, then hit it all at once for the trade.',
    'Fake the defuse to bait the peek, then fight on your terms.',
    'Count their util before retaking, dry retakes into setups just lose.',
    'Tap the spike to force their hand, then punish the peek.',
    'If the retake is a 1v3, save the gun, win next round instead.',
  ],
  dead: [
    'Give comms, how many, where, and what util they burned.',
    'Watch your killer’s angle so the team can pre-aim and trade it.',
    'Call their economy you saw so the team can plan next round.',
    'Use the spec cam to track rotates for your teammates.',
    'Real talk: did you have info before that peek? Play smarter next round.',
    'Dead means coach mode, call crossfires and timings for the squad.',
    'Note the angle that killed you, take it back with util next round.',
  ],
  deathstreak: [
    'Shake it off, that streak’s done, next round’s a fresh start.',
    'Take a breath, calm aim beats panic spray every time.',
    'Play for one clean trade, not a hero clutch. Rebuild your confidence.',
    'Tighten that crosshair placement and let a buddy enter first.',
    'Stop dry-peeking, use util or wait for the trade before you fight.',
    'Play boring and safe this round, a save beats another give-away.',
  ],
  winstreak: [
    'You’re cooking, stay disciplined, don’t get greedy and throw the lead.',
    'Keep running what works, same setups, same trades.',
    'Close it out with clean defaults, not solo ego-peeks.',
    'Trust your reads but keep trading the team, momentum’s fragile.',
    'They’re about to change something, expect a stack or a rush.',
    'Bank your lead, buy smart and keep the util flowing every round.',
  ],

  // ── Tactical (active phase) ──────────────────────────────────────────────────
  lurk: [
    'Lurk works when your team takes space loud on the other side.',
    'Stay quiet and watch the rotate, the info’s worth more than a frag.',
    'Don’t lurk too deep, stay close enough to rotate if they commit.',
    'Catch the rotate in a crossfire, don’t ape into their spawn.',
    'Time your lurk with the spike, flank as they collapse for the retake.',
    'A lurk that never shoots still wins rounds, cut the rotate late.',
    'Walk clear of the fight first, sprinting lurks announce themselves.',
  ],
  trade: [
    'Stay in trade range, if your buddy goes down, swing and refrag.',
    'When a teammate dies, swing now, the enemy’s reloading or low.',
    'Don’t peek one-by-one, go together so you can trade.',
    'If you can see your teammate, you can trade them. Hold that spacing.',
    'Refrag instantly, the second after a kill is when they’re weakest.',
    'Space out but stay connected, stacked heads die to one spray.',
  ],
  crosshair: [
    'Crosshair at head level as you move, never staring at the floor.',
    'Pre-aim the angle before you swing, don’t react after you see ’em.',
    'Hold off the wall a touch so you’re not flicking on first contact.',
    'Counter-strafe to a dead stop before you shoot, moving shots whiff.',
    'Wide-swing with your crosshair already on the pixel they’ll pop from.',
    'Tap or burst at range, only spray when you’re close and confident.',
    'Clear angles in slices, don’t swing everything at once.',
    'Aim where heads will be when they strafe, not where they were.',
  ],
  util: [
    'Use util before you peek, flash, smoke, or drone it, don’t dry-swing.',
    'Flash your own peeks, don’t wait on a teammate to time it.',
    'Combo util, a flash plus a swing beats either one alone.',
    'Save a piece for the post-plant or retake, don’t blow it all on entry.',
    'Smoke to take space for free, then hold the ground you grabbed.',
    'Swing the instant your flash pops, a late swing wastes it.',
    'Use util to cut the site in half, then clear one piece at a time.',
  ],
  rotate: [
    'Check your minimap every few seconds so a rotate never catches you.',
    'Rotate on real info, not every sound, or you’ll get split open.',
    'Rotate early and fast, late rotates walk into a lost site.',
    'Hold the rotate if the spike isn’t down, fakes punish early movers.',
    'Leave someone to watch flank when the team rotates.',
    'Rotate through cover, not open mid, dying on rotate is a free round.',
    'If site’s lost, rotate loud and retake as a unit, don’t trickle.',
  ],
  positioning: [
    'Play an off-angle, not the spot they pre-aim, catch ’em slippin’.',
    'After a kill, reposition, never repeek the same spot they just saw.',
    'Anchor your site, don’t chase early picks and leave it open.',
    'Mix your depth, sometimes deep, sometimes tight, keep ’em guessing.',
    'Isolate one angle at a time so you only fight one enemy at once.',
    'Always have your next cover picked before you take the fight.',
    'Never fight from a spot you can’t fall back from.',
    'Change it up round to round, same position twice is a free pre-aim.',
  ],
  info: [
    'Get info before you commit, a dry push into the unknown just loses.',
    'Jiggle-peek to bait a shot and find the angle without dying.',
    'Sound is info, walk to listen, run when you want tempo.',
    'One pick of info beats a risky frag, play for it.',
    'Bait their util with a fake, then punish the empty hands.',
    'Count bodies on the minimap, math tells you where the last two are.',
    'Silence is info too, a quiet map means they’re stacked somewhere.',
  ],
  default: [
    'Default first, spread the map, get info, then commit as five.',
    'Don’t ape off spawn, take control and let the round breathe.',
    'Play numbers and timers, make them react to you.',
    'A slow default beats a fast feed, take space you can hold.',
    'Hit the site at 40 seconds, late enough for info, early enough to plant.',
    'If they gave you mid for free, punish it, split them wide.',
  ],
  entry: [
    'Entry with util, never dry-swing first onto a site.',
    'Your job entrying is to trade-bait space, team swings right behind you.',
    'Flash for yourself and commit, a half-entry just gets you isolated.',
    'Clear one angle, let your trade clear the next, move as a pair.',
    'Swing shoulder-first through smokes, never walk them slow.',
    'Call your entry timing so the team swings with you, not after you.',
  ],
  clutch: [
    'Clutch time, isolate the 1v1s, never let ’em double-peek you.',
    'Planted? The clock’s on your side, don’t go hunting.',
    'Play for the pick then reposition, let them come to you.',
    'One angle at a time, stay calm, listen for steps.',
    'In a 1vX, hide until they split, then take the 1v1s.',
    'Sound-cue the defuse, you can hear the tap from further than you think.',
    'Don’t force the hero play, a save in a lost clutch is still value.',
  ],
  mental: [
    'Reset between rounds, one breath, then lock back in.',
    'Tilt makes you worse. Last round’s gone, let it go.',
    'Play the round in front of you, not the scoreboard.',
    'Keep comms chill and clear, a sharp team trades and wins.',
    'Losing streak? Slow the game down, walk more, peek less.',
    'Confidence comes from routine, same warmup, same crosshair, same habits.',
  ],
  general: [
    'Win the round, not the duel, sometimes the best peek is no peek.',
    'Play to your util and your team, not for the highlight.',
    'Take the fight the map gives you, not the one your ego wants.',
    'Trade, util, info, position, the fundamentals win every rank.',
    'Every death should teach you one thing, ask what it was.',
    'Timing beats aim, show up where they aren’t ready.',
    'The minimap is your sixth sense, glance at it between every fight.',
    'Win your role, entries entry, anchors anchor, don’t freelance mid-round.',
  ],
};

const TACTICAL = ['crosshair', 'trade', 'util', 'positioning', 'info', 'default', 'rotate', 'lurk', 'entry', 'clutch', 'general'];

// Buy info is "clear" only when both the round and the credits are real numbers.
function buyInfoClear(ctx) {
  return ctx
    && typeof ctx.roundNumber === 'number' && ctx.roundNumber >= 1
    && typeof ctx.playerCredits === 'number' && ctx.playerCredits >= 0;
}

function chooseBucket(ctx) {
  if (!ctx) return pickTactical(ctx);

  if (ctx.consecutiveDeaths >= 3) return 'deathstreak';
  if (ctx.consecutiveWins   >= 3) return 'winstreak';
  if (ctx.phase === 'dead')       return 'dead';

  if (ctx.phase === 'postplant') {
    return ctx.side === 'defense' ? 'retake' : 'postplant';
  }

  if (ctx.phase === 'buy') {
    // Only advise a buy when we can actually read the round + credits.
    if (!buyInfoClear(ctx)) return pickTactical(ctx);
    if (ctx.roundNumber === 1 || ctx.roundNumber === 13) return 'pistol';
    const c = ctx.playerCredits;
    if (c < 2000) return 'eco';
    if (c < 3900) return 'forcebuy';
    return 'fullbuy';
  }

  return pickTactical(ctx);
}

// Active-phase bucket, lightly weighted by situation.
function pickTactical(ctx) {
  let pool = TACTICAL;
  if (ctx) {
    if (ctx.consecutiveDeaths >= 1)   pool = ['positioning', 'crosshair', 'trade', 'util', 'info'];
    else if (ctx.side === 'attack')   pool = ['entry', 'util', 'default', 'trade', 'info', 'positioning'];
    else if (ctx.side === 'defense')  pool = ['positioning', 'crosshair', 'info', 'rotate', 'lurk'];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Pick a fresh, situation-appropriate tip.
 * @param {object} ctx           current match context
 * @param {string[]} recentTexts  tip texts shown recently (for dedup)
 * @returns {{ text: string, bucket: string }}
 */
function selectTip(ctx, recentTexts = []) {
  const bucket = chooseBucket(ctx);
  const pool   = LIBRARY[bucket] || LIBRARY.general;
  const recent = new Set(recentTexts);

  let fresh = pool.filter((t) => !recent.has(t));
  if (fresh.length === 0) fresh = LIBRARY.general.filter((t) => !recent.has(t));
  if (fresh.length === 0) fresh = pool;

  return { text: fresh[Math.floor(Math.random() * fresh.length)], bucket };
}

function size() {
  return Object.values(LIBRARY).reduce((n, arr) => n + arr.length, 0);
}

module.exports = { selectTip, size, buyInfoClear, LIBRARY };
