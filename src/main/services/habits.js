'use strict';

/**
 * The player's recurring mistakes, counted from what the coach actually said.
 *
 * The weekly report already carried a "to improve" list, but it was just the
 * last few weakness sentences the grader wrote, so it changed every week and
 * described a session rather than a player. A habit is different: it is the
 * thing the coach has had to say to you over and over, across games, and it is
 * the only part of this report that earns the word "profile".
 *
 * Counted from the TIPS rather than from the grader's prose, because a tip is
 * tied to a moment the coach actually observed on screen. Prose is a summary of
 * a summary, and summarising twice is how "you over-peek" turns into "focus on
 * fundamentals".
 *
 * Every fix is a concrete instruction the player can hold themselves to in the
 * next game, not a restatement of the problem. "Stop over-peeking" is useless.
 * "After a kill, count one second and move somewhere new before you look again"
 * is something you can actually do.
 */

// Written with a file editor, never through a shell heredoc: a \b that becomes
// a literal backspace still compiles and silently matches nothing, which has
// broken pattern files in this repo before. Every pattern is covered by a test
// asserting it matches a real tip.
const HABITS = [
  {
    id: 'dry-peek',
    label: 'Dry peeking',
    blurb: 'Taking duels with no utility and no flash to open the angle first.',
    fix: 'Before any peek, ask what is opening it: a flash, a smoke, or a teammate. If the answer is nothing, do not take it.',
    re: /\bdry (peek|duel|swing)|peek(ed|ing)? (dry|without (util|utility|a flash))|no util(ity)? before|without utility\b/i,
  },
  {
    id: 'no-trade',
    label: 'Fighting without a trade partner',
    blurb: 'Taking fights where nobody is close enough to punish the enemy who wins.',
    fix: 'Hold yourself to one rule for a whole game: never take a duel unless a teammate is close enough to trade you.',
    re: /\btrade partner|no ?one (to|could) trade|without (a )?trade|nobody (can|could) trade|no teammates? (near|close)|near enough to trade|got traded\b/i,
  },
  {
    id: 'overextend',
    label: 'Over-extending alone',
    blurb: 'Pushing into space ahead of your team, where a lost duel costs the round.',
    fix: 'Glance at the minimap before you take space. If no blue icon can follow you in, hold where you are until one can.',
    // Phrasing varies a lot here, because it is the mistake the coach describes
    // most often and it never says it the same way twice: "overextended solo",
    // "pushed A Sewer alone", "died alone while your team was in spawn". Anchor
    // on the two ideas that actually define it, being by yourself and being
    // away from the team, rather than on any one wording.
    re: /\bover ?extend|over ?commit|(push|peek|enter|went|walked|died|die)\w*[^.]{0,30}\b(alone|solo)\b|\b(alone|solo)\b[^.]{0,40}\byour team\b|your team was (in|still|across|too far)|ahead of your team|without your team|too far forward\b/i,
  },
  {
    id: 'repeek',
    label: 'Repeeking the same angle',
    blurb: 'Looking again from the spot you just won a fight from, where they are now aiming.',
    fix: 'After a kill, move before you look again. Count one second, take a new position, then re-engage.',
    re: /\bre-?peek|peek(ed|ing)? (the same|that) (angle|spot|pixel)|same angle (again|twice)|(reposition|reset)[^.]{0,24}after (the|a|your|first) kill\b/i,
  },
  {
    id: 'crosshair',
    label: 'Crosshair placement',
    blurb: 'Aiming below head height or off the corner you are about to clear.',
    fix: 'Ten minutes of deathmatch where the only goal is keeping the crosshair at head height on the nearest corner.',
    re: /\bcrosshair (placement|too low|at head)|aim(ing)? (too )?low|head height\b/i,
  },
  {
    id: 'wide-swing',
    label: 'Wide swinging into multiple angles',
    blurb: 'Committing into space where more than one enemy can shoot you at once.',
    fix: 'Clear angles one at a time from cover. If two enemies can see you at the same moment, back off instead.',
    re: /\bwide swing|swung wide|multiple angles|two enemies (can|could) see|clear one angle\b/i,
  },
  {
    id: 'util-unused',
    label: 'Dying with utility unused',
    blurb: 'Abilities still on the bar when the round ends, which is value thrown away.',
    fix: 'Spend your kit before contact, not after. If you die with a full bar, name what you were saving it for.',
    re: /\bfull util|unused (util|abilit)|die with (your )?util|did not use (your )?(util|abilit)|save[d]? (your )?util too long\b/i,
  },
  {
    id: 'rotate-late',
    label: 'Rotating late or not at all',
    blurb: 'Holding a dead angle while the round is decided somewhere else.',
    fix: 'Rotate on confirmed information, and rotate early. Arriving halfway through the fight is the same as not arriving.',
    re: /\brotate (early|now|sooner)|late rotat|did ?n[o']t rotate|holding (a )?dead angle|rotate to (the )?(spike|site)\b/i,
  },
  {
    id: 'minimap',
    label: 'Not reading the minimap',
    blurb: 'Walking into information that was already on screen before the fight.',
    fix: 'Glance at the minimap every five seconds, especially before you take space. Most deaths were visible first.',
    re: /\bminimap|check the map\b/i,
  },
  {
    id: 'spike-priority',
    label: 'Playing kills over the spike',
    blurb: 'Hunting fights when the spike, not the scoreboard, decides the round.',
    fix: 'Once the spike is down it is the round. Post-plant, hold angles onto it. On defence, move to it with a plan.',
    re: /\bspike is the (win|round)|go to the spike|retake|defuse|post ?plant\b/i,
  },
];

/**
 * Count habit occurrences across a set of coaching tips.
 *
 * @param sessions [{ at, tips: [{ text }] }]
 * @param limit    how many habits to return
 * @returns [{ id, label, blurb, fix, count, sessions }] most frequent first
 */
// EVIDENCE, NOT ADVICE.
//
// A habit profile must count what the coach saw the player DO, not every tip it
// happened to give. "Rotate to B now" is good advice and says nothing about how
// the player plays; "you died dry peeking A Long" is an observation. Without
// this gate the profile fills up with the coach's own vocabulary and every
// player looks identical.
//
// Tips about the player are written in the second person, which is a reliable
// tell precisely because the prompt insists on it.
const ABOUT_PLAYER = /\byou(r|'?ve|'?re)?\b/i;

function profileHabits(sessions, limit = 3) {
  const tally = new Map();

  for (const s of (sessions || [])) {
    const tips = Array.isArray(s && s.tips) ? s.tips : [];
    // Which habits appeared in THIS session, so "seen in 4 of 5 sessions" is
    // honest. A habit mentioned six times in one game is one bad game; the same
    // habit across six games is who the player is.
    const inSession = new Set();
    for (const t of tips) {
      const text = typeof t === 'string' ? t : (t && t.text) || '';
      if (!text || !ABOUT_PLAYER.test(text)) continue;
      for (const h of HABITS) {
        if (!h.re.test(text)) continue;
        const cur = tally.get(h.id) || { habit: h, count: 0, sessions: 0 };
        cur.count++;
        tally.set(h.id, cur);
        inSession.add(h.id);
      }
    }
    for (const id of inSession) {
      const cur = tally.get(id);
      if (cur) cur.sessions++;
    }
  }

  return [...tally.values()]
    // Recurrence first: a habit across many sessions beats a noisy single game.
    .sort((a, b) => (b.sessions - a.sessions) || (b.count - a.count))
    .filter((r) => r.count >= 2)   // once is a moment, twice starts to be a habit
    .slice(0, limit)
    .map((r) => ({
      id: r.habit.id,
      label: r.habit.label,
      blurb: r.habit.blurb,
      fix: r.habit.fix,
      count: r.count,
      sessions: r.sessions,
    }));
}

module.exports = { HABITS, profileHabits };
