# Occlara

A Valorant AI coaching overlay. An Electron client watches the screen, sends
frames to a Node/Express backend, and shows short coaching tips on top of the
game in real time.

The client never reads game memory, never touches game files, and never
automates input. It captures the display the same way OBS does. That property
is the whole product, so nothing should ever be added that breaks it.

## Layout

```
src/main/          Electron main process (Node). Windows, services, IPC handlers.
src/main/windows/  One file per surface, plus registry.js
src/main/services/ coaching-engine.js is the client brain
src/preload/       One preload per surface, contextBridge only
src/renderer/      The UI. Vanilla HTML + CSS + JS, no framework, no build step
src/shared/        channels.js, config.js, valorant-data.generated.json
server/            Express backend (deployed on Railway)
server/routes/     coach.js holds the prompt and the coaching routes
scripts/           sync-valorant-data.js, sync-patch-notes.js
```

Entry point is `src/main/index.js`. Version lives in `package.json` and is
shown at the bottom of Settings.

```
npm start              run the app
npm run dev            run with devtools and dev userData
npm run sync:valorant  regenerate valorant-data.generated.json
npm run release        build and publish a Windows installer
```

## The UI

Twelve renderer surfaces, each a plain folder with `index.html`, a `.css` and
usually a `.js`:

```
overlay/     the in-game tip cards. The surface players actually see
panel/       the main control window
dock/        the compact always-on-top dock
onboarding/  multi-page first-run flow. The app is gated behind completing it
settings/    all preferences, version string at the bottom
stats/       rank, win rate, match history
history/     past coaching sessions
ailog/       AI decision log: screenshots, STATE, and the tip that was sent
chat/        chat with the AI about one logged frame
weekly/      weekly report popup
activation/  license key entry
audio/       hidden surface, audio capture only. Not a visual surface
```

### Rules for UI work

**There is no build step and no framework.** No React, no JSX, no bundler, no
TypeScript. Plain DOM APIs and plain CSS. Do not introduce a framework or a
build pipeline to add a component.

**Design tokens live in `src/renderer/shared/theme.css`** and are imported by
every surface. Use the variables, do not hardcode colours, radii, easings or
durations:

- Brand: `--red` `#FF4655`, `--cyan` `#FFFFFF`, `--bg` `#08090A`
  The token NAMES are historical. `--cyan` is white and, under
  `[data-game="rivals"]`, `--red` is gold. They mean "primary accent" and
  "secondary accent". Do not rename them: they are consumed 225 times across 15
  files and `npm run check:palette` exists because that edit has gone wrong.
- Text: `--text`, `--text-dim`, `--text-mute`
- Glass: `--glass-fill`, `--glass-border`, `--glass-blur`
- Geometry: `--r-sm` `--r-md` `--r-lg`
- Motion: `--ease`, `--ease-expo`, `--ease-spring`, `--t-fast` `--t-med` `--t-slow`

`src/renderer/shared/ui.css` holds the shared component styles. If two surfaces
need the same thing, it belongs there, not copied into both.

**Geist is bundled locally** in `assets/fonts` so the app renders offline, with
Geist Mono for columns of digits. It ships weights 400, 500, 600, 700 and 800
only. Do not reference a weight outside that set or a webfont URL: the renderer
CSP forbids the URL, and a missing weight silently falls back to Segoe UI, which
changes the shape of the whole interface without erroring.

**Tip card styles are user-configurable.** `tipStyle` in `src/shared/config.js`
is one of `glass | solid | minimal | neon`, and `tipOpacity` runs 0.25 to 1.
The overlay applies them as `data-style` and a `--tip-alpha` variable on
`.tips`. Any new style needs a matching `.tips[data-style="..."]` block in
`overlay/overlay.css` and an option in Settings and onboarding, or the three
will drift out of sync.

Three settled decisions that keep getting reintroduced by accident:

- **No decorative gradients anywhere.** Solid fills and hairline borders. The
  three that remain are functional and deliberate: the loading shimmer in
  `ui.css` and `stats.css`, where the gradient IS the animation, and the radial
  vignette in `splash.css` masking a transparent window.
- **The coaching button stays red.** It is the one control a player must find
  without looking, and the only place the accent earns full saturation in an
  otherwise white-on-black interface.
- **No left accent bar on tip cards.** Accent is carried by the meta dot and
  label colour, via `--tip-accent`.

Transparent or low-opacity tip styles need an outline and a drop shadow, or
they become unreadable against a bright part of the game.

**Every surface must stay visually synchronised.** A change to a shared
component, a token, or a tip style is not done until Settings, onboarding and
the overlay all agree.

## IPC

`src/shared/channels.js` is the single source of truth for every channel name.
It is imported by main, by every preload, and indirectly by every renderer.

**Never hand-type a channel string anywhere else.** The previous client's worst
bug was main and preload drifting to different names, after which the overlay
silently stopped receiving events with no error. Add the constant to
`channels.js` first, then use it on both sides.

Renderers have no Node access. Everything crosses through a preload via
`contextBridge`.

## The coaching pipeline

The client captures a frame, sends it to `POST /api/coach/analyze`, and the
model replies in a fixed two-line shape:

```
<the tip, one sentence>
STATE: {"side":...,"phase":...,"round":...,"hp":...,"alive":...,"map":...,...}
```

Line 1 is shown to the player. Line 2 is parsed by `mapState()` in
`server/routes/coach.js` and fed back as context on the next frame. **If that
format changes, the feedback loop dies silently**: tips keep appearing, they
just stop being informed by anything.

The coach runs `google/gemini-3-flash-preview` on OpenRouter for both vision
and text. There is a credits breaker: on a 402 the server reports it honestly
rather than pretending to be down, and the client backs off for three minutes.

## Do not simplify the guards

`src/main/services/coaching-engine.js` contains deterministic checks that
**deliberately override the model**. Each one exists because of a specific,
reproduced failure, and each one looks like removable defensive cruft until you
know the story. Do not refactor these away.

- **Map lock with correction** (`applyMapRead`). The model repeatedly insisted
  the player was on Ascent while they were on Breeze. Two agreeing reads
  acquire the lock, two agreeing contradictions correct it.
- **Map fingerprint from printed labels** (`applyLocationLabel`,
  `mapFromLabels`). Valorant prints the location name on screen. Accumulated
  labels identify the map far more reliably than the model's guess, and once
  `mapConfirmedByLabels` is true the model can no longer change it.
- **Callout gate.** A tip naming a callout that does not exist on the confirmed
  map is rejected, so the coach cannot send the player to a location from a
  different map.
- **Scoreboard continuity** (`scoreboardChallenge`). Scores never move
  backwards, and a forward jump needs two agreeing reads before it is accepted.
- **HP beats death.** A death is only registered when health is genuinely
  absent and the tell is unambiguous. The model kept announcing deaths that had
  not happened.
- **Death silence** (`DEATH_TIPS_MAX`, `isSpectating`). At most two review tips
  after dying, then nothing until the next buy phase.
- **Play variety** (`PLAY_PATTERNS`). Stops the coach repeating the same stock
  advice, for example telling the player to hold a crossfire every round.
- **Ability gate.** Blocks commands to use abilities the player's agent does
  not have.
- **Reject reasons** (`noteReject`). Records why a tip was dropped so the
  diagnostics payload can explain silence.

The governing principle: **the coach reports what is actually on screen and
never infers.** When code and model disagree, code wins.

## Conventions

**No em dashes or en dashes** anywhere, in tips, in UI copy, in docs. Use
commas. This is a hard rule.

**Never write a regex through a shell heredoc.** `\b` becomes a literal
backspace byte, the file still parses, `node --check` still passes, and the
regex silently matches nothing. This has bitten twice, once killing every
pattern in `PLAY_PATTERNS`. Edit regexes with a file-editing tool, and always
assert a new regex matches a known-positive string.

**Secrets come from the environment.** `.env` and `server/.env` are gitignored
and this repo is public. Never commit a key.

`src/shared/valorant-data.generated.json` is generated by
`npm run sync:valorant` from valorant-api.com. Do not hand-edit it.

**The name is Occlara; the identity is still ghostcoach.** `appId`
(`com.ghostcoach.app2`), `artifactName` (`GhostCoach 2.0 Setup.exe`), the
`GhostCoach-releases` repo and the `%APPDATA%\GhostCoach 2.0` userData folder
all deliberately keep the old name. They are what electron-updater and every
existing install match on, so moving them orphans every user: no updates, no
licence, no history. A brand is what users see; an identity is what the software
is. The userData path is pinned to a literal in `src/main/index.js` rather than
derived from `app.setName`, which is the only reason renaming was safe at all.

**The logo is an aperture, and it exists in four places.** `assets/logo-mark.svg`
is the source; `splash/index.html` and `dock/index.html` inline their own copies
so they can animate and inherit `currentColor`; `scripts/generate-icon.js` draws
it mathematically for the `.ico` and `.png`. Change one and change all of them.
The SVG carries an explicit `color="#FFFFFF"` because an external SVG loaded
through an `<img>` tag is its own document, so `currentColor` resolves to black
there and the mark renders invisible on the dark ground.

**Look at UI changes, do not only compile them.**
`npx electron scripts/shot-surface.js panel settings` writes real screenshots to
`dist-surface-shots/`. A dropped colour declaration, an unshipped font weight and
a stretched logo all pass every automated check in this repo and are obvious in a
picture.

## Releases

Built with electron-builder and updated via electron-updater. Installers are
published to the separate `lowful/GhostCoach-releases` repo, which keeps the old
name on purpose: electron-updater reads it, and the code repo being renamed does
not make it safe to rename. The code repo itself is `lowful/Occlara`, renamed
from `lowful/GhostCoach` on 2026-08-30. When swapping the
asset on the main repo release, the file name must stay exactly
`GhostCoach.2.0.Setup.exe` or existing clients stop auto-updating.

## The website

The marketing site is a **separate private repo**, `lowful/ghostcoach-9a45ac05`.
It is Vite, React, TypeScript, Tailwind and shadcn, and it syncs bidirectionally
with Lovable from `main`. None of this repo's conventions apply there, and none
of its files live here.
