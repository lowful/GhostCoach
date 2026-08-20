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
  - the game prints SUGGESTED PICK: <ROLE> in the bottom right. That is a
    deterministic role recommendation from the game itself, and it is the
    Rivals equivalent of Valorant printing the location name on screen.
