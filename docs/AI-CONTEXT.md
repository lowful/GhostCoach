# Occlara, full context for AI assistants

Paste this whole file into a fresh session to bring an assistant up to speed.
Accurate as of **v5.3.0**. `CLAUDE.md` in the repo root is the enforceable
rulebook and wins wherever the two disagree; this file is the narrative.

---

## 1. What it is

A Valorant AI coaching overlay for Windows. An Electron client watches the
screen, sends frames to a Node/Express backend, and shows one-sentence coaching
tips on top of the game in real time. Players unlock it with a licence key.

**The property the whole product rests on:** the client never reads game memory,
never touches game files, and never automates input. It captures the display the
same way OBS does. Nothing may ever be added that breaks this.

- Client: Electron, vanilla HTML/CSS/JS. **No framework, no bundler, no build
  step, no TypeScript.** Do not introduce one.
- Backend: Node/Express on Railway, auto-deploys when `main` is pushed.
- Code repo `lowful/Occlara`. Releases go to a separate repo (see section 7).

---

## 2. The name, and the five identifiers that did NOT move

The product was **GhostCoach** and was renamed **Occlara** on 2026-08-30
(occlara.app, support@occlara.app). A brand is what users see; an identity is
what the software IS. These still say ghostcoach **on purpose**, because each is
compiled into clients already in the field, and moving one orphans every
existing user: no updates, no licence, no history.

| Identifier | Value | Why frozen |
|---|---|---|
| `build.appId` | `com.ghostcoach.app2` | What Windows and electron-updater match an install on |
| publish repo | `lowful/GhostCoach-releases` | Its URL is compiled into every shipped client |
| Railway host | `ghostcoach-production.up.railway.app` | Baked into `src/shared/config.js` in every build. **The worst of the three to move**: renaming the service breaks coaching and licence checks instantly for everyone on an older build. The safe path is a custom domain pointed at the same service, kept alongside the old hostname forever, never a rename |
| download asset | `GhostCoach.2.0.Setup.exe` | GitHub bakes a filename into its download URL with no redirect, so every link already shared dies without it |
| legacy profile path | `%APPDATA%\GhostCoach 2.0` | Read by the migration below |

**Two that DID move, safely:**

- `artifactName` is now `Occlara Setup.${ext}`. It was never load bearing:
  electron-updater resolves the installer through `latest.yml`, which is
  regenerated every build, and nothing in `src/` hard-codes an installer name.
- The **profile folder** moved to `%APPDATA%\Occlara` and the store file to
  `occlara-config.json`, because unlike the rest it can be moved *with its
  contents*. `src/main/services/profile-migration.js` does it once on launch;
  `npm run test:profilemigration` covers 19 cases including every failure path.
  The rule is **never lose data**: any failure keeps using the old folder and
  the app carries on. It necessarily runs before the single-instance lock (the
  lock lives inside userData), so a second copy launched while the app is
  running does try to move a profile the first has open. Windows refuses that
  rename with EPERM and the fallback keeps both copies on the same folder. Do
  not "fix" that ordering.

Also renamed: the contextBridge is **`window.occlara`** (was `window.ghost`,
127 call sites and 12 preloads), env vars are `OCCLARA_DEV_*`, and the capture
helper is `OcclaraCapture.exe`. **"Ghost" is also a Valorant pistol** and
appears in the coach knowledge, the analyze prompt and the tests; never sweep a
bare "ghost". `btn-ghost` is standard CSS naming for a transparent button and
stays.

---

## 3. The coaching pipeline

Client captures a frame, POSTs to `/api/coach/analyze`, model replies in a fixed
two-line shape:

```
<the tip, one sentence>
STATE: {"side":...,"phase":...,"round":...,"hp":...,"alive":...,"map":...}
```

Line 1 is shown. Line 2 is parsed by `mapState()` in `server/routes/coach.js`
and fed back as context on the next frame. **If that format changes the feedback
loop dies silently**: tips keep appearing, they just stop being informed by
anything.

Model runs on OpenRouter. **The live model is decided by Railway env vars, not
by this repo** (it has been observed serving `qwen/qwen3.7-flash` while docs said
Gemini). A reasoning model returns no tips and nothing looks broken. There is a
credits breaker: on a 402 the server reports it honestly and the client backs
off three minutes.

### Deterministic guards, which deliberately override the model

In `src/main/services/coaching-engine.js`. Each exists because of a specific
reproduced failure and each looks like removable defensive cruft. **Do not
refactor these away.**

- **Map lock with correction** (`applyMapRead`): the model insisted on Ascent
  while the player was on Breeze. Two agreeing reads lock, two agreeing
  contradictions correct.
- **Map fingerprint from printed labels** (`mapFromLabels`): Valorant prints
  location names on screen; accumulated labels beat the model's guess, and
  labels are weighted by rarity because one generic label used to kill the lock
  for a whole session.
- **Callout gate**: a tip naming a callout that does not exist on the confirmed
  map is rejected.
- **Scoreboard continuity**: scores never move backwards; a forward jump needs
  two agreeing reads.
- **HP beats death**: the model kept announcing deaths that had not happened.
  Note the spectator trap, a dead player's HUD shows the *spectated* teammate's
  health.
- **Death silence**: at most two review tips after dying, then nothing until the
  next buy phase.
- **Play variety** (`PLAY_PATTERNS`): stops the same stock advice every round.
- **Ability gate**: blocks commands to use abilities the agent does not have.
- **Reject reasons** (`noteReject`): records why a tip was dropped so the
  diagnostics can explain silence.

Governing principle: **the coach reports what is on screen and never infers.
When code and model disagree, code wins.**

---

## 4. The interface

Twelve renderer surfaces under `src/renderer/`, each a plain folder with
`index.html`, a `.css` and usually a `.js`: overlay, panel, dock, onboarding,
settings, stats, history, ailog, chat, weekly, activation, audio.

**Design tokens live in `src/renderer/shared/theme.css`** and are imported by
every surface. Use the variables, never hardcode:

- `--red` `#FF4655`, `--cyan` `#FFFFFF`, `--bg` `#08090A`. **The names are
  historical**: `--cyan` is white, and they mean "primary accent" and "secondary
  accent". Do not rename them, they are consumed 225 times across 15 files and
  `npm run check:palette` exists because that edit has gone wrong before.
- `--on-accent` is the label colour ON the accent, a token so the two can only
  move together.
- Text `--text` `--text-dim` `--text-mute`, glass `--glass-*`, radii `--r-*`,
  motion `--ease*` `--t-*`.
- **`--space-1..10`** on a 4px grid, and **`--icon-xs/sm/md/lg`**. An audit
  found 28 distinct spacing values, 17 off any grid, and icons picked by hand at
  12/13/15px. The rule that matters most: **space BETWEEN groups must beat space
  WITHIN them**, or nothing groups.

**One palette.** There used to be a `:root[data-game="rivals"]` block painting
the app navy and gold. It is gone; the app looks the same whichever game it is
coaching. `data-game` is still set on `<html>` as the hook if a palette ever
returns.

Settled decisions that keep getting reintroduced by accident:

- **No decorative gradients.** The survivors are functional: the loading shimmer
  and the splash vignette.
- **The coaching button stays red**, at 19px/700. That size is not taste: white
  on the accent measures 3.36:1, WCAG asks 3:1 of large text and large starts at
  18.66px bold, so crossing that threshold fixes contrast without touching a
  brand colour used 225 times.
- **No left accent bar on tip cards.** THE CARD IS THE TIP.
- **Geist only**, bundled in `assets/fonts`, weights 400 to 800. A missing
  weight silently falls back to Segoe UI and reshapes the whole interface.

**Tip glyphs** (`src/renderer/shared/tip-visuals.js`) mark the site, callout,
agent and direction inside a tip. The words are never rewritten. Capped at three
marks, because uncapped one card came back with five bold runs and emphasis that
covers half a sentence has stopped being emphasis. The lexicon's hazard is short
tokens: a case-insensitive `a` matches the A site **and every article in
English**, which has broken three rules here, one of them inside a checker
written to catch it. Sites match only as an uppercase letter plus a site noun,
agents match case-sensitively, and every pattern is tested with a negative.

**The dropdown** (`src/renderer/shared/dropdown.js`) replaces the native
`<select>`, which rendered as a white Windows box on a dark card. It keeps real
combobox semantics. Its list is **portalled to `document.body`** while open,
because `transform`, `filter` and `backdrop-filter` all make an element the
containing block for fixed-position descendants and every card here is `.glass`.
That single fix ends three separate bugs: stacking context, overflow clipping,
containing block.

---

## 5. IPC

`src/shared/channels.js` is the single source of truth for every channel name,
imported by main, every preload, and indirectly every renderer. **Never
hand-type a channel string anywhere else.** The previous client's worst bug was
main and preload drifting to different names, after which the overlay silently
stopped receiving events with no error. Renderers have no Node access;
everything crosses through a preload via `contextBridge`.

---

## 6. Marvel Rivals, current status

Registered in `src/shared/games.js` as **preview, not shipped**:
`features = { review: true, draft: false }`, hidden unless `devGames` is on.

**Built and passing (all offline, no external dependency):**

- `server/services/rivals-heroes.js` — 40 heroes classified by role, aim
  (hitscan/projectile/melee), air (flight/leap/ground) and archetype, plus 13
  named but unclassified in `PENDING`. 40 + 13 = 53, which independently
  matches the `META.heroCount` in `rivals-knowledge.js`.
  **ABSENCE MEANS SILENCE**: an unknown hero returns null and produces no advice
  at all, so being a season behind costs coverage, never correctness.
- `server/services/rivals-counters.js` — the switch call, including
  flight-into-hitscan. Will not fire on one enemy, while the player is winning,
  about a hero it cannot vouch for, or twice for the same reason in a match.
- `src/shared/rivals-moments.js` — WHEN a live tip may appear: death, team wipe,
  objective flip, round start. Six per match, 25s minimum gap. A 6v6 shooter has
  almost no readable moments, so speech has to be earned rather than timed.
- Role glyphs in `tip-visuals.js` (shield / blade / cross) plus the hero NAME.
  **Never a portrait**: shipping Marvel or NetEase character art in a paid
  product is a trademark problem.
- `POST /api/rivals/identify` — returns a roster and nothing else, so the hero
  read is gradeable, plus `npm run verify:rivalsheroes` to grade it.

**The blocker is the hero read, not data.** Live tips are only as good as knowing
who is on screen. `verify:rivalsheroes` scores it against real frames in
`fixtures/rivals/` (gitignored). **Precision is the gate at 90%**: recall can be
poor and this still ships because unknown heroes are already silence, but
nothing downstream catches a hero that was never there.

**Every external source has been checked and rejected. Do not re-litigate:**

| Source | Why not |
|---|---|
| `marvelrivalsapi.com` | 502 throughout. Only its docs host is up |
| `externref/marvelrivalsapi` | Python wrapper for the above |
| `MarvelRivalsAPI/MarvelRivalsAPI-Wrapper` | Official Node wrapper for the above. Same dead upstream |
| `AImaginationLab/marvel-rivals-mcp` | **Do not install.** Calls `marvelsapi.com`, which redirects to `survey-smiles.com`. Parked domain, survey spam |
| `Causalzap/rivalsvictory-assets` | 40 heroes vs 53, no licence, no aim/mobility data |
| `rivalsdata.com` | robots.txt allows crawling but the server 403s a self-identifying bot. Getting past that means pretending to be Chrome, so no scraper ships |
| `tracker.gg` | robots.txt disallows `/marvel-rivals/matches/*` and `/*/profile/*`. **Their public API is the one live lead**: it answers 401 rather than 404 on a marvel-rivals route, so the route exists. Worth trying with the `TRACKER_API_KEY` already on Railway |

There is **no official Marvel Rivals developer API**. Every tracker derives data
by scraping, community submission, or network monitoring, and that last one is
something this product can never do.

## 7. Release and ops

```
npm start                 run it
npm test                  36 offline checks, the gate (check:release is a
                          preflight and is excluded by the runner on purpose)
npm run release           build + publish + refresh the public download
npm run verify:ai         AI regression gate, costs money, needs a real profile
npm run sync:valorant     regenerate valorant-data.generated.json
npx electron scripts/shot-surface.js <surface>   screenshot a surface
```

Release: bump `package.json`, `npm test`, commit, push, then `npm run release`
with a `GH_TOKEN`. electron-builder publishes to **GhostCoach-releases** (that
is what electron-updater reads), then `scripts/publish-download.js` refreshes
the main repo's single release, id **296500148**, tag **`Release`**, publishing
the same bytes under **two** names: `Occlara-Setup.exe` for every new link and
`GhostCoach.2.0.Setup.exe`, which must never be removed.

**Run `npm run verify:ai` after ANY prompt or model change.** It grades the coach
against real frames and has thresholds for tip return, STATE parsing, guard
inputs, survivor rate and accuracy.

---

## 8. Conventions and traps

- **No em dashes or en dashes anywhere**, in tips, UI copy, docs or commits. Use
  commas. Hard rule.
- **Never write a regex through a shell heredoc.** `\b` becomes a literal
  backspace byte, the file still parses, `node --check` still passes, and the
  regex silently matches nothing. Doubled backslashes collapse too. Use a
  file-editing tool, and assert every new regex against a known-positive AND a
  known-negative string.
- **Secrets come from the environment.** `.env` is gitignored and **this repo is
  public**. Never commit a key.
- `src/shared/valorant-data.generated.json` is generated. Do not hand-edit.
- **Look at UI changes, do not only compile them.** A dropped colour, an
  unshipped font weight and an invisible logo all pass every automated check in
  this repo and are obvious in a picture. Real bugs caught only by screenshot:
  the mark rendering black-on-black, tip cards washing out, the live indicator
  sitting at opacity 0 for its entire life, a dropdown drawn under the row below
  it, and labels clipped to "Portug...".
- **An empty result is a claim.** `grep -viF` crashes in this environment and
  prints nothing, turning a failed audit into a false all-clear. Print the count
  from the stage before the filter before believing a negative.
- **The logo is an aperture and exists in four places**: `assets/logo-mark.svg`,
  inlined in splash and dock so they can animate, and drawn mathematically in
  `scripts/generate-icon.js`. Change one, change all. The SVG carries an
  explicit `color="#FFFFFF"` because an external SVG in an `<img>` is its own
  document, so `currentColor` would resolve to black and the mark would be
  invisible.

---

## 9. Honest current limitations

- Rivals draft coaching is not built, and its data source is down.
- The live model is set outside this repo, so `/health` is the only truth.
- The overlay's tip glyph lexicon covers Valorant vocabulary only.
- Tips are still full sentences. Compressing them into comms shorthand would
  need a prompt change and the AI regression gate, and risks losing the "why"
  that is most of the coaching.
- The marketing site is a **separate private repo** (`lowful/ghostcoach-9a45ac05`,
  Vite/React/Tailwind, syncs with Lovable). None of this repo's conventions
  apply there.
