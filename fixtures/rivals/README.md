# Rivals reference frames

Real captures the Rivals coach is built and tested against, the same way the
Valorant guards were each written against a frame that had proved the model
wrong about something.

Not committed. These are pictures of somebody's screen and this repository is
public, so the folder is gitignored and the frames live only on the machine
doing the work.

Expected files:

  draft-vanguard.png    hero select, Vanguard tab open
  draft-duelist.png     hero select, Duelist tab open
  draft-strategist.png  hero select, Strategist tab open
  scoreboard.png        post match scoreboard

What the draft frames establish, which the written plan had wrong:

  - hero select shows YOUR team only. The enemy roster is not on screen at any
    point, so counter picking cannot happen at draft. It has to move to the
    mid match switch call, where the enemy team is visible.
  - the game prints SUGGESTED PICK: <ROLE> in the bottom right. It looked like
    the Rivals equivalent of Valorant printing the location name on screen, and
    it is NOT trustworthy the same way. Across four frames of one draft, 22s
    down to 2s, it read VANGUARD the whole way while the team slots filled up,
    and that match's scoreboard shows a finished 2-2-2 with the player on a
    Duelist. So the readable roster decides and the banner corroborates.

    Whether the banner is genuinely static, or was simply right about a team
    that later swapped heroes, is the one open question a live run settles.
    Rivals lets players change hero mid match, so the scoreboard shows the
    FINAL comp rather than the drafted one, and that is the loose end.
