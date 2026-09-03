'use strict';

/**
 * The League curriculum: what to learn, in what order, and how to check it.
 *
 * THIS IS THE ONE PART OF THE APP THAT TEACHES RATHER THAN REACTS. Every other
 * surface answers "what is happening right now"; this answers "what should I
 * understand before the next game". So the writing rules are different:
 *
 * - Every lesson states the MISTAKE it fixes, not the mechanic it describes.
 *   "Last hitting" is a topic. "You are pushing the wave without meaning to"
 *   is a lesson, because a player can recognise themselves in it.
 * - Every lesson is finishable in a couple of minutes. A player opens this
 *   between games, not instead of them.
 * - Every practice question has a WRONG answer that is genuinely tempting.
 *   A quiz whose distractors are obviously silly measures nothing.
 *
 * Order matters. Tracks run fundamentals, then laning, then macro, because
 * macro advice is noise to someone still losing lane, and the app should not
 * teach rotations to a player missing half their minions.
 *
 * Plain data, no DOM, so it is testable offline: test:lolcurriculum asserts
 * every id is unique, every answer index is in range, and every lesson has at
 * least one question.
 */

const TRACKS = [
  {
    id: 'fundamentals',
    name: 'Fundamentals',
    blurb: 'The four habits that decide more games than mechanics do.',
    lessons: [
      {
        id: 'f-csing',
        title: 'Gold comes from minions, not kills',
        mistake: 'Chasing kills while your minions die untouched.',
        body: [
          'A caster minion is worth about as much as a third of a kill, and there are around a hundred of them before twenty minutes. A player on 60 CS at ten minutes is not slightly behind a player on 90, they are a full item behind.',
          'Last hitting is a timing skill, not an aim skill. Watch the minion health bar, not your champion. Attack when the bar reaches roughly the damage of one of your hits, accounting for the travel time if you are ranged.',
          'The number to beat first is not 10 CS per minute. It is beating YOUR last game. Check the scoreboard at ten minutes every game and try to add five.',
        ],
        practice: [
          {
            q: 'You can either take a risky fight for a kill, or step back and collect six minions safely. Which is worth more?',
            options: ['The kill, always', 'Roughly the same, so take the safer one', 'The minions, they are guaranteed'],
            answer: 2,
            why: 'Six minions is close to a kill in gold, and it carries no risk of dying and losing both the gold and the time. Guaranteed beats likely.',
          },
        ],
      },
      {
        id: 'f-death',
        title: 'Dying costs more than the gold',
        mistake: 'Treating a death as an even trade because you got a kill for it.',
        body: [
          'A death costs you the gold, plus every minion that dies while you walk back, plus the objectives the enemy takes in that window. At twenty minutes a death is thirty seconds of walking on top of the respawn.',
          'That is why a one-for-one trade is often bad for you. If you die under their tower and they die in the open, you lose more time getting back to lane than they do.',
          'Before you commit, ask what happens if it goes wrong, not what happens if it goes right.',
        ],
        practice: [
          {
            q: 'You trade one for one with the enemy laner at 25 minutes. Who gained?',
            options: ['Nobody, it was even', 'Whichever team was already ahead', 'Whichever team can use the time better, usually the one nearer an objective spawning'],
            answer: 2,
            why: 'The kills cancel out. What does not cancel out is what happens during the two respawns, so the team with an objective up gained.',
          },
        ],
      },
      {
        id: 'f-vision',
        title: 'A ward is a cheaper death',
        mistake: 'Holding a trinket because there was no obvious reason to place it.',
        body: [
          'Your trinket recharges whether or not you use it, so an unused ward is wasted by definition. The only question is where, not whether.',
          'Ward where you intend to walk, a little before you walk there. A ward placed after you are already deep tells you what killed you.',
          'The most valuable ward in the early game is not in the enemy jungle, it is on the path between the enemy jungler and your lane.',
        ],
        practice: [
          {
            q: 'You are pushing toward the enemy tower and your trinket is up. Where does it go?',
            options: ['On the enemy tower to watch for defenders', 'In the river or jungle entrance behind you', 'Hold it until you see a threat'],
            answer: 1,
            why: 'Pushing means standing further from safety. The danger is what arrives from behind you, not what is in front of you.',
          },
        ],
      },
      {
        id: 'f-map',
        title: 'Look at the map on a timer, not on a feeling',
        mistake: 'Only checking the minimap after something has already gone wrong.',
        body: [
          'Most deaths to a gank were visible on the minimap several seconds earlier. The information was there and nobody looked.',
          'Tie the glance to something you already do. Every time you last hit a cannon minion, or every time you use an ability, flick to the map. It becomes automatic in a few games.',
          'What you are looking for is absence. Not "where is the jungler" but "which enemies can I NOT see right now", because those are the ones who can reach you.',
        ],
        practice: [
          {
            q: 'You glance at the map and cannot see the enemy jungler or mid laner. What does that mean?',
            options: ['Nothing, they are probably farming', 'Two people could arrive, so play as if they will', 'Ping danger and back off immediately every time'],
            answer: 1,
            why: 'Absence is information. It does not mean retreat every time, it means the risk of pushing up just doubled, so price it in.',
          },
        ],
      },
    ],
  },
  {
    id: 'laning',
    name: 'Laning',
    blurb: 'Winning the two-minute stretches that decide the lane.',
    lessons: [
      {
        id: 'l-wave',
        title: 'The wave has a direction and you chose it',
        mistake: 'Hitting minions whenever they are in range, then wondering why you are shoved in.',
        body: [
          'Every minion you damage that you did not need to damage pushes the wave toward the enemy tower. Push is not a decision you make once, it is the sum of a hundred small ones.',
          'Shoving the wave is right when you want to recall, when you want to roam, or when you are about to take an objective. It is wrong when the enemy jungler is nearby and you have no vision.',
          'If you want the wave to come back to you, hit only the minions that are about to die.',
        ],
        practice: [
          {
            q: 'You want to recall for an item. What should the wave be doing?',
            options: ['Sitting in the middle of the lane', 'Pushed toward the enemy tower', 'Frozen near your tower'],
            answer: 1,
            why: 'A shoved wave dies to their tower while you are away, so you lose the least. Recalling on a frozen wave hands the enemy free minions.',
          },
        ],
      },
      {
        id: 'l-trade',
        title: 'Trade when the minions are on your side',
        mistake: 'Trading on raw cooldowns while six of their minions hit you.',
        body: [
          'Minion damage decides most early trades. Stepping up to hit the enemy while their whole wave is alive means you take the trade AND the wave.',
          'The good moments are when their wave is smaller than yours, right after they use an important ability, or as their minions are about to die and yours are not.',
          'This is why pushing without a reason hurts twice: it gives up the wave and it makes every trade worse.',
        ],
        practice: [
          {
            q: 'The enemy just used their main damage ability on a minion. What is the window?',
            options: ['Back off, they are trying to bait', 'Step up and trade before it comes back', 'Ignore it and keep farming'],
            answer: 1,
            why: 'A spent cooldown is the cleanest trading window there is, and it lasts only as long as the cooldown does.',
          },
        ],
      },
      {
        id: 'l-recall',
        title: 'Recall timing is an item lead',
        mistake: 'Backing when you die, or when you happen to notice you are low.',
        body: [
          'A good recall costs you nothing: the wave is shoved, you buy something that matters, and you walk back to a lane that has not moved.',
          'A bad recall costs a wave, a tower plate, and sometimes the lane. Backing with 700 gold when 900 buys the component that wins the matchup is often worse than staying.',
          'Plan the back one wave early. Ask what you are buying before you decide to go.',
        ],
        practice: [
          {
            q: 'You have 1150 gold and your next spike costs 1300. The wave is about to crash into your tower.',
            options: ['Back now, gold in hand is safe', 'Hold, take the wave under tower, then back with the spike', 'Fight for a kill to make up the difference'],
            answer: 1,
            why: 'Recalling 150 short means walking back without the item that changes the lane. The wave under tower pays for it in about twenty seconds.',
          },
        ],
      },
      {
        id: 'l-roam',
        title: 'Leave lane only when leaving costs nothing',
        mistake: 'Roaming mid and losing more at home than you gained away.',
        body: [
          'A roam is a trade: you give up whatever happens in your lane for whatever happens in theirs. It is only good when your lane loses little.',
          'The cheap moments are just after you shove a wave, just after the enemy recalls, or when your wave is about to die to their tower anyway.',
          'If you leave a frozen wave to walk mid, you will come back down two waves whether the roam worked or not.',
        ],
        practice: [
          {
            q: 'When is the cheapest moment to walk to another lane?',
            options: ['When your wave is frozen at your tower', 'Right after you shove the wave into their tower', 'When you are low on health'],
            answer: 1,
            why: 'A shoved wave means your minions do the farming for a few seconds. That is the only window where leaving costs close to nothing.',
          },
        ],
      },
    ],
  },
  {
    id: 'macro',
    name: 'Macro',
    blurb: 'Turning a lead into a win, which is a separate skill from getting one.',
    lessons: [
      {
        id: 'm-objectives',
        title: 'Set up the objective before it spawns',
        mistake: 'Noticing the dragon exists when the timer hits zero.',
        body: [
          'An objective is won in the ninety seconds before it spawns, not in the fight over it. Vision goes down, the waves get pushed, and the team that did both arrives with a choice.',
          'The practical version: about a minute before it spawns, push your wave so it cannot be collected by the enemy, then move.',
          'A team that walks to dragon from a frozen lane arrives late, outnumbered, and behind on vision.',
        ],
        practice: [
          {
            q: 'Dragon spawns in 60 seconds. What matters most right now?',
            options: ['Standing on the pit waiting', 'Shoving your wave and placing vision around the pit', 'Looking for a pick anywhere on the map'],
            answer: 1,
            why: 'Arriving with the wave handled and vision down is what gives you the choice to take it or contest. Standing there early just gives up farm.',
          },
        ],
      },
      {
        id: 'm-tempo',
        title: 'A tower is worth more than a kill you did not need',
        mistake: 'Winning a fight and then standing over the bodies.',
        body: [
          'The reward for winning a fight is the time the enemy spends dead. Spending that time on nothing is the most common way a won fight changes nothing.',
          'The order is usually: take the nearest objective, then the wave, then look for the next fight.',
          'If you cannot name what you are taking before the fight starts, you are fighting for its own sake.',
        ],
        practice: [
          {
            q: 'You win a 5v5 near mid with three enemies dead. What comes first?',
            options: ['Chase the two survivors', 'Take the nearest tower or objective', 'Recall to buy while you have gold'],
            answer: 1,
            why: 'The dead timer is the resource. Recalling spends it on nothing and chasing risks handing a kill back.',
          },
        ],
      },
      // REPLACED 'm-position', which read "In a teamfight, your job depends on
      // your range". That lesson was true and completely ungradeable: the Live
      // Client Data API publishes scores and timestamped events and no position
      // data whatsoever, so nothing could ever check whether a player stood in
      // the right place. This one measures the two ways games are actually lost
      // at these ranks, and both fall out of kill timestamps alone.
      //
      // Anyone who had completed the old lesson loses that tick, because the id
      // changed. summarise() already ignores ids it does not recognise, which is
      // exactly why progress is stored as a list of ids rather than a count.
      {
        id: 'm-numbers',
        title: 'Numbers decide fights before abilities do',
        mistake: 'Walking into a fight that was already lost before you arrived.',
        body: [
          'Most lost fights were lost on the count, not on the play. Four into five is a losing fight however well it is played, and the count is visible on the minimap several seconds before the fight starts.',
          'The two expensive deaths look different and cost the same. One is arriving late to a fight your team has already lost, where you die second and give up a second body. The other is being caught alone with nobody near you, where the fight was never happening at all.',
          'Before you walk toward a fight, count. If you cannot see enough allies arriving, the answer is to take something else on the map instead, because a fight you decline costs nothing.',
        ],
        practice: [
          {
            q: 'A teammate dies in a fight near dragon. You are ten seconds away and your other two allies are across the map.',
            options: ['Go in, they need the help and your damage might turn it', 'Take a side wave or a tower instead, the fight is already lost', 'Wait at the edge and look for a pick'],
            answer: 1,
            why: 'Arriving after a death means fighting into more enemies than allies. The fight is decided; taking something elsewhere while they finish it is the only move that gains anything.',
          },
        ],
      },
      {
        id: 'm-close',
        title: 'Know what actually ends the game',
        mistake: 'Being far ahead at thirty minutes and losing at forty.',
        body: [
          'A lead does not win on its own; it decays. Every minute you do not convert it, the enemy gets closer to items that close the gap.',
          'Converting means taking things that do not respawn: towers, inhibitors, and eventually the nexus. Kills and dragons are means, not the end.',
          'The most common throw is taking a fight you do not need while a lead is already enough. Ask what you gain if you win it. If the answer is nothing you do not already have, do not take it.',
        ],
        practice: [
          {
            q: 'You are 10k gold ahead with two inhibitors down. The enemy is grouped mid.',
            options: ['Force the fight, you win it on gold', 'Take a side lane and make them choose between you and the wave', 'Wait for their next mistake at your base'],
            answer: 1,
            why: 'A 5v5 is the one place a gold lead can be erased by one bad angle. Splitting forces a choice where either answer loses them something.',
          },
        ],
      },
    ],
  },
];

/** Every lesson, flattened, in curriculum order. */
function lessons() {
  const out = [];
  for (const t of TRACKS) for (const l of t.lessons) out.push(Object.assign({ trackId: t.id, trackName: t.name }, l));
  return out;
}

function lessonCount() { return lessons().length; }

/** A lesson by id, or null. Same silence rule as everywhere else. */
function lesson(id) {
  return lessons().find((l) => l.id === String(id || '')) || null;
}

/**
 * Progress summary for a set of completed ids.
 *
 * Unknown ids are ignored rather than counted, so a lesson removed in an update
 * cannot push someone above 100% or leave them stuck at a total they can never
 * reach again.
 */
function summarise(doneIds) {
  const valid = new Set(lessons().map((l) => l.id));
  const done = (Array.isArray(doneIds) ? doneIds : []).filter((id) => valid.has(id));
  const total = valid.size;
  return {
    done: done.length,
    total,
    pct: total ? Math.round((done.length / total) * 100) : 0,
    byTrack: TRACKS.map((t) => ({
      id: t.id,
      name: t.name,
      done: t.lessons.filter((l) => done.includes(l.id)).length,
      total: t.lessons.length,
    })),
  };
}

module.exports = { TRACKS, lessons, lessonCount, lesson, summarise };
