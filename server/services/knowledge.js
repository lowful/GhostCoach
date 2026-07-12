'use strict';

/**
 * The Pro Playbook: a tagged, queryable library of proven high-elo Valorant
 * habits (distilled from Radiant, Immortal, and pro play). Instead of pasting
 * the same static list into every prompt, retrieve() scores each note against
 * the CURRENT match situation (agent, map, side, phase, economy, weapon,
 * streaks) and returns only the most relevant few, so a Jett on Ascent attack
 * in a force buy gets Jett, Ascent, attack, and force buy knowledge.
 *
 * Growing the playbook needs NO code changes:
 *   - add entries to PLAYBOOK below, or
 *   - drop extra entries into server/data/playbook.json (same shape), which is
 *     merged at startup. That file is where knowledge extracted from coaching
 *     videos and pro VODs lands (transcribe, extract rules with an LLM, tag,
 *     append). The coach is smarter on the very next request.
 *
 * Note shape (every tag optional; untagged notes apply everywhere):
 *   {
 *     text:       'one concrete sentence, comma punctuation only',
 *     side:       'attack' | 'defense',
 *     phase:      'buy' | 'active' | 'postplant' | 'dead',
 *     situations: ['pistol','eco','forcebuy','fullbuy','antieco','lostpistol',
 *                  'deathstreak','winstreak','retake','early'],
 *     roles:      ['duelist','controller','initiator','sentinel'],
 *     agents:     ['Jett', ...],   // only served once the agent is CONFIRMED
 *     maps:       ['Ascent', ...],
 *     weapons:    ['operator', ...], // substring match on the player's weapon
 *     weight:     1..3             // base priority (default 1)
 *   }
 */

const fs   = require('fs');
const path = require('path');

const PLAYBOOK = [
  // ── universal fundamentals ──────────────────────────────────────────────
  { text: 'Clear one angle at a time from cover, never wide swing into multiple uncleared angles at once.', weight: 3 },
  { text: 'Keep your crosshair at head height on the edge of the nearest corner, pre aim where a head will appear.', weight: 3 },
  { text: 'Counter strafe before shooting, release your movement key, tap the opposite one, and fire the first accurate shot.', weight: 2 },
  { text: 'Reposition immediately after a kill, repeeking the same pixel is how you hand the kill back.', weight: 3 },
  { text: 'Only take fights with a trade partner in view, if nobody can trade your death, do not take the duel.', weight: 3 },
  { text: 'Jiggle peek for info with quick side taps, wide swing only when you intend to commit to the fight.', weight: 2 },
  { text: 'Glance at the minimap every 5 seconds, most deaths were visible on the map before they happened.', weight: 3 },
  { text: 'Count footsteps and call them, sound tells you enemy numbers before your eyes do.', weight: 1 },
  { text: 'Shift walk once you are within earshot of enemies, run only while your position is not useful information.', weight: 1 },
  { text: 'Play the range of your gun, a Spectre wants close angles, rifles want mid range, an Operator wants the longest sightline.', weight: 1 },
  { text: 'Never look at the floor or a wall while moving, keep the crosshair working head height every step you take.', weight: 1 },
  { text: 'Isolate your duels, fight where only one enemy can see you, back off when two can shoot you at once.', weight: 2 },
  { text: 'Play your life when your gun matters, throwing away a rifle costs your team this round and the next.', weight: 1 },
  { text: 'Win the fights you choose, not the fights they offer, if a peek feels forced, back off and reset.', weight: 1 },
  { text: 'In a clutch, isolate one duel at a time and use the spike timer to force them to come to you.', weight: 1 },
  { text: 'Rotate with your knife out through safe or cleared space for the speed, and switch to your gun before you reach possible contact.', weight: 2 },
  { text: 'Patterns repeat until punished, if they hit the same site twice in a row, expect it again and pre stack util there.', weight: 2 },
  { text: 'Read the minimap for absence, no contact anywhere by mid round means a stack or a late hit, call it before the timer forces panic.', weight: 1 },
  { text: 'Call enemy positions in three words, place, number, action, "two B main pushing" wins rounds, essays lose them.', weight: 1 },

  // ── aim ─────────────────────────────────────────────────────────────────
  { text: 'Burst 2 to 4 bullets at range and reset the spray, holding the trigger past 6 bullets is throwing bullets.', weight: 1 },
  { text: 'First bullet accuracy decides rifle duels, be standing fully still for the first shot, always.', weight: 2 },
  { text: 'Aim at the head of the model, not the chest, one headshot beats four body shots in every economy.', weight: 2 },
  { text: 'If you whiffed a fight, check your crosshair placement first, most whiffs start at the wrong height, not slow flicks.', weight: 1 },
  { text: 'Do not ADS a rifle in close fights, hip fire is faster and just as accurate up close.', weight: 1 },
  { text: 'Warm up before queueing, 10 minutes of deathmatch on counter strafe headshots beats an hour of mindless fragging.', weight: 1 },

  // ── movement and peeking ────────────────────────────────────────────────
  { text: 'Wide swing when you know exactly where they are, shoulder peek when you do not, never half commit a peek.', weight: 2 },
  { text: 'Peek with a plan, know your cover and your exit before you step out of safety.', weight: 1 },
  { text: 'Clear close corners before long angles, the close enemy kills you first.', weight: 2 },
  { text: 'Use peekers advantage, the swinger sees the holder first, so swing with intent instead of creeping into view.', weight: 1 },
  { text: 'Do not panic crouch mid duel, it slows you into a free headshot, strafe instead.', weight: 1 },
  { text: 'Jump spot only for info you can call out, you cannot shoot accurately in the air.', weight: 1 },
  { text: 'Fall back through your util, a retreat covered by a smoke or flash is a reset, a naked retreat is a free kill for them.', weight: 1 },
  { text: 'Hold angles at different depths each round, close one round and far the next, never be standing where you died.', weight: 2 },

  // ── utility craft ───────────────────────────────────────────────────────
  { text: 'Use util to answer util, if they smoke your angle then reposition or molly the push, do not dry hold a smoke.', weight: 2 },
  { text: 'Never die with full util, an unused ability is value thrown away for nothing.', weight: 2 },
  { text: 'Throw util for a purpose you can name, info, space, delay, or a kill, never just because it is up.', weight: 2 },
  { text: 'Combo your utility, a flash into a swing, a stun into an entry, solo util is half value.', weight: 1 },
  { text: 'Respect enemy util timings, most teams burn util early in the round, play patient through it then take the space.', weight: 1 },
  { text: 'Bait enemy util before committing, a fake peek that pulls their flash makes the real swing free.', weight: 1 },

  // ── info, comms, minimap ────────────────────────────────────────────────
  { text: 'Call what you see the instant you see it, one enemy spotted changes your whole team’s round.', weight: 2 },
  { text: 'Watch teammate fights on the minimap even from across the map, their contact sets your timing.', weight: 1 },
  { text: 'When a teammate dies, note WHERE from the kill feed, that enemy is still near there.', weight: 2 },
  { text: 'Count the enemies seen this round, five accounted for means your flank is safe, three means it is not.', weight: 2 },
  { text: 'Use the round timer as info, a quiet first 30 seconds means a default or a late hit is coming.', weight: 1 },
  { text: 'If you are going to die anyway, burn their util and count bodies out loud for your team.', weight: 1 },
  { text: 'Keep comms short, position, number, action, then quiet, backseat comms while dead lose retakes.', weight: 1 },

  // ── sound ───────────────────────────────────────────────────────────────
  { text: 'Play off sound, running steps are audible around 20 meters, silence means shift walkers or nobody.', weight: 1 },
  { text: 'Your reload is a callout to the enemy, reload behind cover, never in the open after a kill.', weight: 2 },
  { text: 'Fake sound cues work, run a few loud steps one way then shift walk the other to sell a rotation.', weight: 1 },
  { text: 'Listen for ability audio, a plant, a teleport, an ult voice line, each is a free minimap ping in your head.', weight: 1 },

  // ── attack ──────────────────────────────────────────────────────────────
  { side: 'attack', text: 'Default for info first, take map control with util, then commit to a site as five once you have a read.', weight: 3 },
  { side: 'attack', text: 'Trade your entry, when your duelist swings you swing within one second, not after they die.', weight: 3 },
  { side: 'attack', text: 'Use util before contact, flash or smoke the angle you fear, then peek off your own utility.', weight: 3 },
  { side: 'attack', text: 'Save one smoke or flash for the post plant, a naked post plant loses to any organized retake.', weight: 2 },
  { side: 'attack', text: 'If all the noise is on one site, the opposite lurk gets a free flank or a free read, use the weak side.', weight: 1 },
  { side: 'attack', text: 'Push tempo through space your team already owns, do not re clear what is already held.', weight: 1 },
  { side: 'attack', text: 'If the entry dies untraded, regroup and reset the hit, do not trickle one by one into the same angle.', weight: 2 },
  { side: 'attack', text: 'Lurk with purpose, cut the rotation or catch the flank exactly when your team hits, not while they wait.', weight: 1 },
  { side: 'attack', text: 'Hit a split together, both prongs must swing within seconds of each other or each dies alone.', weight: 1 },
  { side: 'attack', text: 'Assign one player to watch the flank on every hit, a single defender walking in behind undoes the entire entry.', weight: 2 },
  { side: 'attack', text: 'If the call is fast, commit fast, slow rolling a rush hands the defense free seconds to reset.', weight: 1 },
  { side: 'attack', text: 'If first contact shows a stacked site, rotate early as five, do not force into a prepared defense.', weight: 1 },
  { side: 'attack', phase: 'postplant', text: 'Plant for cover, then play off site with crossed angles on the spike, never stand on top of it.', weight: 3 },
  { side: 'attack', phase: 'postplant', text: 'Hold the defuse from range with a molly or ability lined up, utility wins post plants without a duel.', weight: 3 },
  { side: 'attack', phase: 'postplant', text: 'Numbers up in the post plant, play time, every second without a fight is a second won.', weight: 2 },
  { side: 'attack', phase: 'postplant', text: 'Spread out after the plant, two attackers holding the same angle die to a single flash.', weight: 2 },
  { side: 'attack', phase: 'postplant', text: 'Watch the flank in the post plant, retakes love to send one player around the back while the rest make noise.', weight: 2 },

  // ── defense ─────────────────────────────────────────────────────────────
  { side: 'defense', text: 'Hold an off angle for the first peek, then change spots, defenders die getting pre aimed in default positions.', weight: 3 },
  { side: 'defense', text: 'Set crossfires so any entry gets shot from two angles, a solo site hold needs util to delay, not duels.', weight: 3 },
  { side: 'defense', text: 'Delay a committed push with utility, you only need to buy seconds for your rotation to arrive.', weight: 2 },
  { side: 'defense', text: 'Do not over peek after your opening kill, give ground, they now have to find you all over again.', weight: 2 },
  { side: 'defense', text: 'Call the push early and loud, a 5 second earlier rotate call wins the retake before it starts.', weight: 1 },
  { side: 'defense', text: 'Do not chase kills off your site, a frag that pulls you out of position trades your bombsite for a kill.', weight: 2 },
  { side: 'defense', text: 'If they saved last round expect a rush with shotguns, hold range and do not push into close corners.', weight: 1 },
  { side: 'defense', text: 'Vary your setup every round, the best defenders are never standing where they killed or died last round.', weight: 2 },
  { side: 'defense', text: 'Take one aggressive info peek at round start only with an escape planned and a teammate covering the fall back.', weight: 1 },
  { side: 'defense', text: 'A quiet early round means a default or a late hit, keep your util and do not burn smokes at nothing.', weight: 1 },
  { side: 'defense', text: 'Retreat off site before you are surrounded, alive behind them beats dead on them, then retake with your team.', weight: 1 },
  { side: 'defense', text: 'Once they fully commit to the far site, a timed flank through their entry path arrives behind the post plant, go with a call, not alone.', weight: 2 },
  { side: 'defense', phase: 'postplant', situations: ['retake'], text: 'Retake as a unit behind util, flash or smoke the planter cover and swing together, never one by one.', weight: 3 },
  { side: 'defense', phase: 'postplant', situations: ['retake'], text: 'Play the defuse math, full defuse is 7 seconds and half is 3.5, tap the half defuse to bait their peek.', weight: 2 },
  { side: 'defense', phase: 'postplant', situations: ['retake'], text: 'Clear the common post plant spots before touching the spike, tapping into three crosshairs is a throw.', weight: 2 },
  { side: 'defense', phase: 'postplant', situations: ['retake'], text: 'Use the spike audio, the fast beeps mean commit now, before that you still have time to clear properly.', weight: 1 },
  { side: 'defense', phase: 'postplant', text: 'If the retake is not winnable, save your gun and util, winning the next two rounds beats a hero attempt.', weight: 2 },

  // ── round-type play (HOW to play the round type, never WHAT to buy;
  //     buy advice is retired on player feedback) ─────────────────────────
  { situations: ['eco'], text: 'Broke round, stack together for one close range pick and play the time down, do not spread thin and feed one by one.', weight: 3 },
  { situations: ['eco'], text: 'On a broke round play for damage, info, and time, chip their armor, do not gift the kill feed a 5 for 0.', weight: 2 },
  { situations: ['pistol'], text: 'Pistols reward the first accurate headshot, take close fights and burst, do not spray at range.', weight: 2 },
  { side: 'attack', situations: ['pistol'], text: 'On attack pistol, group as five with one plan, spread out pistol duels favor the defenders.', weight: 2 },
  { side: 'defense', situations: ['pistol'], text: 'On defense pistol, play crossfire pairs close together, a solo pistol duel is a coin flip, a trade is not.', weight: 2 },
  { situations: ['forcebuy'], text: 'On cheap guns take close fights, a Spectre or shotgun loses every long range duel to a rifle.', weight: 3 },
  { situations: ['antieco'], text: 'You won pistol so they are broke, hold range and open ground, do not push corners where a Classic wins.', weight: 3 },
  { situations: ['antieco'], text: 'Anti eco rounds are positioning, not aim, make them cross open ground into rifles and never chase into close quarters.', weight: 2 },

  // ── streaks and mental ──────────────────────────────────────────────────
  { situations: ['deathstreak'], text: 'You have died several rounds in a row, change your timing, peek earlier or later, they have your pattern read.', weight: 3 },
  { situations: ['deathstreak'], text: 'Dying first means you are taking first contact alone, wait for a teammate in trade range before you peek.', weight: 3 },
  { situations: ['deathstreak'], text: 'Reset the tilt, play one simple round with your team, no hero plays, just trades and discipline.', weight: 2 },
  { situations: ['winstreak'], text: 'Keep the same pace on a win streak, streaks end on overconfident dry peeks, stay disciplined.', weight: 2 },
  { situations: ['winstreak'], text: 'A losing team forces or rushes out of impatience, hold your discipline and punish the desperation.', weight: 1 },
  { text: 'Mistakes are data, name what killed you in one sentence, fix that one thing next round, then move on.', weight: 1 },
  { text: 'Do not relive the last round during this round, reviewing one mid fight is how you lose two.', weight: 1 },

  // ── dead / spectating ───────────────────────────────────────────────────
  { phase: 'dead', text: 'While dead, spectate for info and call setups and rotations, and note exactly what killed you for next round.', weight: 2 },
  { phase: 'dead', text: 'While dead, watch how the enemy who killed you plays that position, then punish the habit next round.', weight: 1 },
  { phase: 'dead', text: 'Decide your next buy while dead, weapon and util now, so the buy phase is spent positioning, not shopping.', weight: 1 },

  // ── ult economy ─────────────────────────────────────────────────────────
  { text: 'Grab the ult orbs when a fight is over, free ult progress this round wins a future round.', weight: 1 },
  { text: 'Count enemy ults, a Jett with knives or a Raze with rocket changes which angles are safe to hold.', weight: 1 },
  { text: 'Ults convert advantages, break open an even round with one, a solo ult into five players is a donation.', weight: 1 },
  { text: 'If your ult is up and the round is already won or lost, hold it, next round starts with a weapon in hand.', weight: 1 },

  // ── weapons (matched to what the player is actually holding) ────────────
  { weapons: ['operator'], text: 'With the Operator hold one long sightline at max range and reposition the moment you fire, never re scope the same pixel.', weight: 3 },
  { weapons: ['operator'], text: 'Pick the sightline they must cross and let them walk into your Operator, you win by holding, not hunting.', weight: 2 },
  { weapons: ['operator'], text: 'Do not push with the Operator, a moving Op is just a very expensive knife, let the fight come to your scope.', weight: 2 },
  { weapons: ['spectre', 'stinger'], text: 'The Spectre loses every long duel, play elbows, corners, and smoke edges, force fights inside 15 meters.', weight: 3 },
  { weapons: ['spectre', 'stinger'], text: 'The Spectre stays accurate on the move up close, strafe fight inside rooms where rifles must stand still.', weight: 2 },
  { weapons: ['judge', 'bucky', 'shorty'], text: 'A shotgun owns doorways and tight corners, hold the pixel where they funnel and take one body per shell.', weight: 3 },
  { weapons: ['judge', 'bucky', 'shorty'], text: 'Never hold open ground with a shotgun, hide close and let them walk past your corner.', weight: 2 },
  { weapons: ['sheriff'], text: 'The Sheriff one taps heads at close and mid range, aim head height only and refuse spray fights.', weight: 2 },
  { weapons: ['sheriff'], text: 'A Sheriff eco wants off angles and single peeks, take one pick then immediately relocate.', weight: 2 },
  { weapons: ['guardian'], text: 'The Guardian wins standing still at range, take the long angle, tap heads, and back off when they close distance.', weight: 2 },
  { weapons: ['marshal', 'outlaw'], text: 'A Marshal or Outlaw is an eco Operator, take one long jiggle pick from range then rotate away before they close.', weight: 2 },
  { weapons: ['odin', 'ares'], text: 'The Odin sprays through thin cover, pre fire the known spots and wall bang the plant, but never take a clean open duel with it.', weight: 2 },
  { weapons: ['classic'], text: 'The Classic right click is a tiny shotgun, use it inside 5 meters only, single taps beyond that.', weight: 2 },
  { weapons: ['ghost'], text: 'The Ghost rewards head taps at ranges other pistols cannot reach, play it like a mini Guardian.', weight: 2 },
  { weapons: ['phantom'], text: 'The Phantom sprays through smokes with no tracers up close, spray the smoke edge where they cross.', weight: 1 },
  { weapons: ['vandal'], text: 'The Vandal one taps at every range, slow your fights down to single accurate shots, especially at distance.', weight: 1 },
  { weapons: ['knife'], text: 'Knife out is for covering ground fast, the moment contact is possible your gun comes out, before the corner, not after.', weight: 3 },

  // ── roles (apply once the confirmed agent maps to a role) ───────────────
  { roles: ['duelist'], side: 'attack', text: 'Your entry creates space even when traded, but swing WITH your util as it lands, never before it.', weight: 2 },
  { roles: ['duelist'], text: 'Entry means in first, not in alone, check your team is actually moving behind you before you commit.', weight: 2 },
  { roles: ['duelist'], side: 'attack', text: 'Take the first fight where your team can follow, entry into the site, not into a lonely flank.', weight: 2 },
  { roles: ['duelist'], text: 'Entry then survive, a duelist still alive after the opening trade snowballs the whole round.', weight: 1 },
  { roles: ['controller'], side: 'attack', text: 'Smoke the crossing sightlines that stop your team walking in, not random doors, cut what actually kills.', weight: 2 },
  { roles: ['controller'], text: 'Time smokes with the hit, a smoke blooming as you enter beats one thrown a minute early.', weight: 2 },
  { roles: ['controller'], text: 'Keep one smoke in reserve for the post plant or retake, an empty controller loses late rounds.', weight: 2 },
  { roles: ['controller'], text: 'Smoke for the plan, ask for the call before barriers drop so your first smokes match the hit.', weight: 1 },
  { roles: ['initiator'], text: 'Recon before the swing and act on your own info within seconds, scans expire fast.', weight: 2 },
  { roles: ['initiator'], text: 'Flash for your teammate swing, not your own peek, a flash nobody swings on is wasted util.', weight: 2 },
  { roles: ['initiator'], text: 'Fire the set piece then enter WITH your team, initiators who stay behind to watch die last for nothing.', weight: 1 },
  { roles: ['initiator'], text: 'Re gather info mid round, a second recon or drone at 40 seconds catches the rotation everyone missed.', weight: 1 },
  { roles: ['sentinel'], side: 'attack', text: 'The moment your team commits to a site, set your utility watching the flank, that is your job before your gun.', weight: 2 },
  { roles: ['sentinel'], side: 'defense', text: 'Place trips and alarms where they buy you time, not in the first doorway everyone clears for free.', weight: 2 },
  { roles: ['sentinel'], side: 'defense', text: 'Anchor discipline, stay alive holding your site until help arrives, dying early hands the site over free.', weight: 2 },
  { roles: ['sentinel'], text: 'Your value is time, play setups that kill slow pushes and delay fast ones, not aim duels.', weight: 1 },

  // ── agent specific (served only after the player confirms the agent) ────
  { agents: ['Jett'], text: 'Dash is your exit ticket, take the aggressive off angle only while dash is up, play passive without it.', weight: 2 },
  { agents: ['Jett'], text: 'An updraft peek works once, the second one gets pre aimed, use it somewhere different.', weight: 1 },
  { agents: ['Reyna'], text: 'Your kit only works off the opening pick, take the first duel with a trade or flash, then dismiss out.', weight: 2 },
  { agents: ['Reyna'], text: 'Devour after every safe kill, a healed Reyna snowballs, but dismiss instead when a second enemy still sees you.', weight: 1 },
  { agents: ['Phoenix'], text: 'Throw the curveball tight around the corner for your own swing, it pops fast and blinds the holder first.', weight: 2 },
  { agents: ['Phoenix'], text: 'Your wall and molly heal you, start a risky take by walling in and top up when chipped.', weight: 1 },
  { agents: ['Raze'], text: 'Send the boombot first to pull attention, then satchel or swing in behind it, never enter dry.', weight: 2 },
  { agents: ['Raze'], text: 'Save the rocket for grouped enemies at a choke or a retake deny, one kill with it wastes a round winner.', weight: 1 },
  { agents: ['Neon'], text: 'Sprint to close the distance then STOP before shooting, speed wins the position, standing still wins the duel.', weight: 2 },
  { agents: ['Neon'], text: 'Use your wall to cut the site in half on entry, enemies behind it cannot trade the first fight.', weight: 1 },
  { agents: ['Yoru'], text: 'Place your teleport before the fight so every aggressive peek has an exit.', weight: 2 },
  { agents: ['Yoru'], text: 'Bounce the flash off a wall so it pops behind the angle, then swing the blind, not before it.', weight: 1 },
  { agents: ['Iso'], text: 'Take your shield before every planned duel, one absorbed bullet decides rifle fights.', weight: 2 },
  { agents: ['Iso'], text: 'Isolate one enemy at a time, your kit rewards clean 1v1s, not spray downs into a crowd.', weight: 1 },
  { agents: ['Waylay'], text: 'Set your beacon before taking the aggressive angle, Refract is a free exit from any peek.', weight: 2 },
  { agents: ['Waylay'], text: 'Your dashes take space fast, but land behind cover, speed into open ground is a fast death.', weight: 1 },
  { agents: ['Sova'], text: 'Learn one recon lineup per site and fire it before every hit, your team should never enter blind.', weight: 2 },
  { agents: ['Sova'], text: 'Walk your duelist in with the drone, tag the holder and let them swing on the dart.', weight: 1 },
  { agents: ['Breach'], text: 'Flash through the wall for your team swing, your util needs no exposure, so lead every fight with it.', weight: 2 },
  { agents: ['Breach'], text: 'Stun the push as it commits, a stunned rush walking into your crossfire is a free round.', weight: 1 },
  { agents: ['Skye'], text: 'Run the flash for your entry and call the pop, a bird nobody swings on is wasted.', weight: 2 },
  { agents: ['Skye'], text: 'Send the dog into the corner your team fears most just before they walk in.', weight: 1 },
  { agents: ['KAY/O'], text: 'Pop the knife before the hit, suppressed defenders cannot flash, trip, or smoke your entry.', weight: 2 },
  { agents: ['KAY/O'], text: 'Throw the flash high and short so it pops right on their screen, then swing instantly with your team.', weight: 1 },
  { agents: ['Fade'], text: 'Haunt the site before entry, a revealed defender is half dead, and send the prowler at whoever it marks.', weight: 2 },
  { agents: ['Fade'], text: 'Seize the anchor spot, a held enemy cannot escape the trade.', weight: 1 },
  { agents: ['Gekko'], text: 'Wingman can plant and defuse, send it for the plant while you hold the angle, it flips post plants.', weight: 2 },
  { agents: ['Gekko'], text: 'Dizzy pops fast, throw it just before your team swings, then pick the blinded holder.', weight: 1 },
  { agents: ['Tejo'], text: 'Save the guided missiles for locked setups and post plants, they force players off positions without a peek.', weight: 2 },
  { agents: ['Tejo'], text: 'Fly the drone for quiet info before the hit, walking in blind wastes your kit.', weight: 1 },
  { agents: ['Omen'], text: 'Teleport behind your own smoke for the unexpected angle, and re smoke the choke as fights reset.', weight: 2 },
  { agents: ['Omen'], text: 'Paranoia through the wall as your team swings, a blinded crossfire is two free kills.', weight: 1 },
  { agents: ['Brimstone'], text: 'Drop smokes the second the hit starts, yours land instantly from the map, there is no excuse for a dry entry.', weight: 2 },
  { agents: ['Brimstone'], text: 'Hold the molly for the defuse, lineup or not, it wins post plants on its own.', weight: 1 },
  { agents: ['Viper'], text: 'Your molly on the spike wins post plants, hold it until the defuse actually starts.', weight: 2 },
  { agents: ['Viper'], text: 'One wall set at the barrier can cut the whole site, place it early and manage fuel through the round.', weight: 1 },
  { agents: ['Astra'], text: 'Set your stars during the buy phase for where fights will happen, repositioning mid fight takes you out of the game.', weight: 2 },
  { agents: ['Astra'], text: 'Gravity well the off angle or retake corner, it drags them into your team crosshairs.', weight: 1 },
  { agents: ['Harbor'], text: 'Cove blocks bullets, plant inside it or reset a broken fight behind it.', weight: 2 },
  { agents: ['Harbor'], text: 'Ride High Tide with your team, a wall nobody follows is just noise.', weight: 1 },
  { agents: ['Clove'], text: 'You can smoke even while dead, keep smoking for your team every fight, that is your value.', weight: 2 },
  { agents: ['Clove'], text: 'Pick Me Up after a kill buys the tempo for the next fight, chain duels while it lasts.', weight: 1 },
  { agents: ['Sage'], text: 'Wall to slow the push or split the site in half, and save resurrection for a player in a winning position.', weight: 2 },
  { agents: ['Sage'], text: 'Slow orb the choke as they commit, a slowed rush dies to any crossfire.', weight: 1 },
  { agents: ['Killjoy'], text: 'A setup that got kills will get cleared next round, move your turret and swarms every round or two.', weight: 2 },
  { agents: ['Killjoy'], text: 'Lockdown wins retakes and stops hits, hide it deep so it finishes, a broken ult is a wasted round.', weight: 1 },
  { agents: ['Cypher'], text: 'Rotate your trip spots between rounds, a spotted setup is a dead setup.', weight: 2 },
  { agents: ['Cypher'], text: 'Recam and reposition after the camera is spotted, a known camera feeds them info, not you.', weight: 1 },
  { agents: ['Chamber'], text: 'Play angles only while Rendezvous is up, take one shot and teleport out before the trade arrives.', weight: 2 },
  { agents: ['Chamber'], text: 'Headhunter turns your ecos into Sheriff rounds, aim head height and tap.', weight: 1 },
  { agents: ['Deadlock'], text: 'Sonic sensors stop running pushes, cover the path a rush must sprint through, and pair them with info for walkers.', weight: 2 },
  { agents: ['Deadlock'], text: 'GravNet the choke as they commit, netted enemies crawl into your crossfire.', weight: 1 },
  { agents: ['Vyse'], text: 'Arc Rose flashes from the wall itself, place it where you fight so you can flash your own swing anytime.', weight: 2 },
  { agents: ['Vyse'], text: 'Hide Shear behind the entry corner, the pop up wall splits their push and isolates the first man.', weight: 1 },

  // ── map specific ────────────────────────────────────────────────────────
  { maps: ['Ascent'], text: 'Mid control decides Ascent, cat and market open both sites, fight for mid with util every round.', weight: 2 },
  { maps: ['Ascent'], text: 'Use the site doors on Ascent, closing a door mid execute splits their team and buys the retake.', weight: 1 },
  { maps: ['Bind'], text: 'No mid on Bind means teleporters decide rotations, listen for the TP audio and punish predictable takes.', weight: 2 },
  { maps: ['Bind'], text: 'Hookah and showers decide Bind, take or smoke them first, control there opens both sites.', weight: 2 },
  { maps: ['Haven'], text: 'Three sites make Haven rotations slow, call contact early on defense and fake one site to pull the rotate on attack.', weight: 2 },
  { maps: ['Haven'], text: 'Garage is the hinge of Haven, holding it lets you threaten or defend two sites at once.', weight: 1 },
  { maps: ['Split'], text: 'Mid control feeds both Split sites through vents and mail, take or deny mid before committing anywhere.', weight: 2 },
  { maps: ['Split'], text: 'Split is close quarters, Spectres, shotguns, and off angles shine, and clear heaven on every site take.', weight: 1 },
  { maps: ['Icebox'], text: 'Icebox is vertical, clear high angles first and only take ziplines when someone covers the ride.', weight: 2 },
  { maps: ['Icebox'], text: 'Plant behind cover on Icebox, open plants die to the long sightlines onto both sites.', weight: 1 },
  { maps: ['Breeze'], text: 'Breeze sightlines are long, rifles and Operators rule, do not force close range buys on gun rounds.', weight: 2 },
  { maps: ['Breeze'], text: 'Take space slowly on Breeze, the open ground punishes dry crosses, move behind util or not at all.', weight: 1 },
  { maps: ['Fracture'], text: 'Attackers come from both sides on Fracture, on defense expect the pincer and call which half arrives first.', weight: 2 },
  { maps: ['Fracture'], text: 'On attack Fracture, split your util across both entrances and hit the site from two directions at once.', weight: 1 },
  { maps: ['Pearl'], text: 'Mid control on Pearl opens both sites and the flanks, do not let them own mid for free.', weight: 2 },
  { maps: ['Pearl'], text: 'Pearl has no vertical tricks, it is all crossfires and corners, clear methodically and never dry cross mid.', weight: 1 },
  { maps: ['Lotus'], text: 'The rotating doors on Lotus give away every rotation, keep one watched or tripped and use their audio for your own timing.', weight: 2 },
  { maps: ['Lotus'], text: 'Lotus has three sites, defense cannot hold all of them, read the lean and rotate off first contact.', weight: 1 },
  { maps: ['Sunset'], text: 'Sunset mid is the hinge, control it to threaten both sites and cut their rotations.', weight: 2 },
  { maps: ['Sunset'], text: 'Sunset sites are tight with strong close corners, clear with util, dry entries die to a shotgun every time.', weight: 1 },
  { maps: ['Abyss'], text: 'You can fall off Abyss, mind the edges in fights and never strafe blind near the void.', weight: 2 },
  { maps: ['Abyss'], text: 'Abyss drops enable surprise rotations, but you cannot climb back up, drop only with a plan.', weight: 1 },
];

// Optional growth file: knowledge extracted from videos and VODs merges here.
let EXTRA = [];
try {
  const p = path.join(__dirname, '..', 'data', 'playbook.json');
  if (fs.existsSync(p)) {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(parsed)) EXTRA = parsed.filter((n) => n && typeof n.text === 'string');
    console.log('[knowledge] merged', EXTRA.length, 'playbook notes from data/playbook.json');
  }
} catch (e) {
  console.error('[knowledge] playbook.json ignored:', e.message);
}

const ALL = PLAYBOOK.concat(EXTRA);

// Agent -> role, so role notes fire off the confirmed agent.
const ROLE_OF = {
  jett: 'duelist', reyna: 'duelist', phoenix: 'duelist', raze: 'duelist',
  neon: 'duelist', yoru: 'duelist', iso: 'duelist', waylay: 'duelist',
  omen: 'controller', brimstone: 'controller', viper: 'controller',
  astra: 'controller', harbor: 'controller', clove: 'controller',
  sova: 'initiator', breach: 'initiator', skye: 'initiator', 'kay/o': 'initiator',
  fade: 'initiator', gekko: 'initiator', tejo: 'initiator',
  sage: 'sentinel', killjoy: 'sentinel', cypher: 'sentinel',
  chamber: 'sentinel', deadlock: 'sentinel', vyse: 'sentinel',
};

/** Read the live context into the flags the notes are tagged with. */
function situationOf(ctx) {
  const phaseRaw = String(ctx.phase || '').toLowerCase();
  const phase = phaseRaw.includes('buy') ? 'buy'
    : (phaseRaw.includes('plant') || phaseRaw.includes('post')) ? 'postplant'
    : phaseRaw === 'dead' ? 'dead'
    : 'active';

  const side = String(ctx.side || '').toLowerCase();
  const sideKey = side.includes('att') ? 'attack' : side.includes('def') ? 'defense' : null;

  const round   = Number(ctx.roundNumber) || 0;
  const credits = ctx.playerCredits == null ? null : Number(ctx.playerCredits);
  const team    = Number(ctx.teamScore)  || 0;
  const enemy   = Number(ctx.enemyScore) || 0;
  const flags   = new Set();
  if (round === 1 || round === 13) flags.add('pistol');
  if (phase === 'buy' && credits != null && !flags.has('pistol')) {
    if (credits < 2000) flags.add('eco');
    else if (credits < 3900) flags.add('forcebuy');
    else flags.add('fullbuy');
  }
  // Round after a pistol: the score tells us who is rich and who is broke.
  if (round === 2 || round === 14) {
    if (team > enemy) flags.add('antieco');
    else if (enemy > team) flags.add('lostpistol');
  }
  if ((Number(ctx.consecutiveDeaths) || 0) >= 2) flags.add('deathstreak');
  if ((Number(ctx.consecutiveWins)   || 0) >= 2) flags.add('winstreak');
  if (sideKey === 'defense' && phase === 'postplant') flags.add('retake');
  if (round > 0 && round <= 3) flags.add('early');

  const agent  = typeof ctx.agent === 'string' && ctx.agent ? ctx.agent : null;
  const role   = agent ? ROLE_OF[agent.toLowerCase()] || null : null;
  const map    = typeof ctx.map === 'string' && ctx.map ? ctx.map.toLowerCase() : null;
  const weapon = typeof ctx.playerWeapon === 'string' && ctx.playerWeapon ? ctx.playerWeapon.toLowerCase() : null;

  return { phase, side: sideKey, flags, agent, role, map, weapon };
}

/**
 * Retrieve the most relevant playbook notes for this exact situation.
 * Contradicting notes (wrong side, wrong phase, another agent's note, a gun
 * the player is not holding) are excluded outright; the rest are scored by
 * how specifically they match.
 */
function retrieve(ctx, limit = 8) {
  const s = situationOf(ctx || {});
  const scored = [];

  for (const note of ALL) {
    // Exclusions: a tagged note never fires outside its tags.
    if (note.side  && s.side  && note.side  !== s.side)  continue;
    if (note.side  && !s.side) continue;                     // side unknown: skip side notes
    if (note.phase && note.phase !== s.phase) continue;
    if (note.agents && (!s.agent || !note.agents.some((a) => a.toLowerCase() === s.agent.toLowerCase()))) continue;
    if (note.roles  && (!s.role  || !note.roles.includes(s.role))) continue;
    if (note.maps   && (!s.map   || !note.maps.some((m) => m.toLowerCase() === s.map))) continue;
    if (note.weapons && (!s.weapon || !note.weapons.some((w) => s.weapon.includes(w)))) continue;
    if (note.situations && !note.situations.some((f) => s.flags.has(f))) continue;

    // Score: specificity of the match, plus base weight, plus a tiny jitter so
    // near ties rotate between requests instead of always serving one order.
    let score = note.weight || 1;
    if (note.agents)  score += 4;
    if (note.weapons) score += 4;
    if (note.maps)    score += 3;
    if (note.situations) score += 2 * note.situations.filter((f) => s.flags.has(f)).length;
    if (note.side)    score += 2;
    if (note.phase)   score += 2;
    if (note.roles)   score += 2;
    score += Math.random() * 0.8;

    scored.push({ text: note.text, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((n) => n.text);
}

/** The prompt block /analyze injects in place of (or alongside) the static habits list. */
function block(ctx, limit) {
  const notes = retrieve(ctx, limit);
  if (!notes.length) return '';
  return 'PRO PLAYBOOK (proven Radiant and pro habits retrieved for THIS exact situation, ground your tip in these before anything generic):\n'
    + notes.map((t) => '- ' + t).join('\n');
}

module.exports = { retrieve, block, situationOf, size: () => ALL.length };
