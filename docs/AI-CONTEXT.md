# GhostCoach, Full Context for AI Assistants

Last updated: July 21, 2026 (v2.2.0). Everything below is accurate to the shipped product.

## 1. What GhostCoach is

GhostCoach is a real-time AI coaching app for Valorant on Windows. It runs as a transparent, click-through overlay on top of the game, takes screenshots on a timer, sends them to a vision AI, and shows short coaching tips as cards on screen while the player plays. Think of it as a Radiant-level coach watching your screen live.

- Desktop client: Electron app, Windows only, NSIS installer, auto-updates.
- Backend: Node/Express server hosted on Railway at ghostcoach-production.up.railway.app. Auto-deploys when the main branch is pushed.
- Business model: paid license keys (weekly, monthly, lifetime) sold through Stripe via the website ghostcoachai.com (site built on Lovable). The app activates with a license key and binds to a device ID.
- Repos: lowful/GhostCoach (source, client + server), lowful/GhostCoach-releases (public, hosts auto-update releases only).

## 2. The AI brain

- Vision model: Qwen3-VL 235B (qwen/qwen3-vl-235b-a22b-instruct) through OpenRouter, using the OpenAI-compatible API. Chosen for strong game-HUD reading at low cost. Model is set by Railway env vars AI_VISION_MODEL and AI_TEXT_MODEL.
- Gemini is a legacy fallback (used only if no OpenRouter key is set) and is still used for one thing: audio analysis, because it is the only configured provider that accepts audio.
- The coaching loop sends a screenshot roughly every 1 to 24 seconds depending on the user's tip-frequency setting (turbo 1s up to battery 24s). Tips have their own pacing: 3s cooldown at Max stepping to 8s at Minimal.

### The STATE protocol (important)
Every analyze response has two lines. Line 1 is the tip (or SKIP, or LOBBY when not in a match). Line 2 is `STATE: {json}` where the model reports what the HUD shows: side, phase, round, team/enemy score, credits, alive, teammates alive, enemies alive, weapon, map, mode (the queue, only when printed on screen), playerSpot (the player's own minimap-arrow location, site level), enemySpot, teamRead (pre-round minimap plan), and note (a factual observation about the player). The client parses this and feeds it back as context on the next request, which is how the app maintains match awareness. Death reviews are marked with a "DEATH: " prefix that the server strips into a flag so the client renders them as white skull cards.

### Tip quality gates (client side, about 20 of them)
Every tip passes gates before showing: no economy/buy advice (banned entirely), no abilities the agent does not have, no wrong-map callouts, no teammate-dependent tips when the player is solo (alive counts checked), no knife tips outside the death-review window, the anti-repeat gate (see below), topic cooldown (3 identical topics in a row blocked), word caps, truncation rejection, 3-strike blocklist (a tip X-rated 3 times by the player is never shown again, and their written reason for the X is sent to the model to learn from), and per-tier pacing. Rejected tips fall back to a curated library tip (246-note knowledge base) so silence stays rare.

Anti-repeat gate (three rules, added in 2.2.0 because back-to-back repeats kept slipping through the old 60-second-only window): (1) verbatim wording never repeats within the last 25 tips no matter how much time passed, (2) a tip that heavily overlaps the tip right before it (>75% word overlap, a light reshuffle) is a repeat at any age, (3) moderate overlap (>50%) with anything from the last 60 seconds is a rapid-fire duplicate. Deliberate re-warnings in fresh wording with escalation ("still", "again", "third time now") pass. Library fallback tips run through the same gate and re-roll away from near-duplicates; the prompt also names the tip currently on screen and forbids echoing it.

### Deterministic guards (code overrides the model when math is available)
- Halftime side arithmetic is MODE-AWARE (2.2.0): unrated/competitive halves are 12 rounds (swap at 13, overtime 25+ alternates so the HUD read is trusted there); swiftplay halves are 4 rounds (swap at 5, sudden-death round 9 trusts the HUD). Once one half's side is known (locked after two agreeing reads), the rest of the half structure is derived by arithmetic and OVERRIDES the model's read.
- Game mode locking: the mode comes from two agreeing STATE reads (the model only reports it when the queue name is printed on screen), from score math (a 6th round win or a 10th round can only be a standard match, checked over two consecutive frames, and this even corrects a wrong swiftplay lock), or from an observed side swap in rounds 5-8 (two consecutive flipped reads, which only swiftplay does there). Until the mode is known, arithmetic only overrides rounds where both modes agree on the half (1-4 and 10-24), so a swiftplay round 5 swap is never bulldozed by 12-round math.
- New-match reset: the round counter falling back to 1 with a 0-0 score (all three fields agreeing in the same frame) resets the side and mode locks, so a second match in one session never inherits the previous match's side.
- Death confirmation: the player only counts as dead after two consecutive dead reads (or an explicit dead phase), because one flashbang whiteout used to fake deaths.
- Agent and map lock once detected and never change mid-session.

## 3. Feature inventory (all shipped and working)

- Live tips: AI (cyan cards) + library (red cards) + system notices. Position/size/frequency configurable. Voice coach setting speaks tips aloud via Windows TTS with 5 styles (Normal, Hype, Chill, Funny, Robot) and volume control, off by default.
- Death reviews: white skull cards explaining why the player died (or why a round was lost), only when the cause is actually visible; the model holds small observations and delivers them at death time.
- Match review after each session plus a graded session recap (summary, strengths, weaknesses) written in coach voice.
- Stats dashboard: Overview (Impact, Positioning, Utility, Aim, Rank, Win Rate), Top Agents (3 most played with official portraits, winrate, KD, ACS), Recent Matches (expandable rows with graded tracker stats and MVP badges), Coaching Sessions (graded, with the recap), and a Rank Journey graph (RR line over recent comp games) inside the rank drop-down. Everything switches between Competitive and Unrated (unrated + swiftplay merged) with genuinely different per-mode numbers.
- Rating categories: Impact (ACS-anchored, replaced Economy which was ungradeable), Positioning, Utility, Aim. Blend: 60 percent tracker data, 40 percent AI session grades.
- Match MVP / Team MVP: derived server-side by comparing all 10 players' scores from match details, cached permanently per match.
- Shareable match cards: generated on demand (button in each match drop-down, local canvas render, no AI cost), styled like a trading PnL card: dark background, agent full portrait, match rating pill, RESULT / K/D/A / RR rows, ACS/ADR/HS%/DMG tiles, MVP chip, riot tag. Save as PNG or copy to clipboard.
- Ask Coach chat seeded with session context, player stats, and trends.
- Audio death forensics: a hidden window loopback-records the last 8 seconds of game audio; inside the death window the clip is analyzed (footsteps, abilities heard) to explain deaths.
- Player accounts: Riot ID connect (Name#TAG), stats via HenrikDev API (tracker.gg is Cloudflare-blocked from cloud hosts and only a fallback). Changing the Riot ID wipes all cached data live, including in an open stats window.
- Auto-update: electron-updater against the public GhostCoach-releases repo, checks instantly on launch and every 6 hours, differential downloads, "Restart now / Later" prompt, installs on quit if deferred.
- Onboarding (tour + the fundamental-tips question: curated basics on or off, on by default, recommended off above Silver; the answer writes the beginnerTips setting and can be changed later in Settings under "Fundamental tips"), license activation, tray, hotkeys, minimized floating ghost dock.

## 4. Hard-won lessons (what did NOT work and how it was fixed)

These are the traps another AI should not re-suggest:

1. PowerShell screen capture gets flagged by Windows Defender as HackTool:PowerShell/EmpireGetScreenshot (it matches PowerShell Empire's Get-Screenshot signature). FIXED by replacing it with a tiny compiled C# helper (native/GhostCoachCapture.exe, built with the csc.exe that ships in Windows, GDI CopyFromScreen, base64 JPEG to stdout, about 66ms, no temp files). Do not go back to PowerShell or to Electron's desktopCapturer (the in-process capturer stutters fullscreen games).
2. The NSIS uninstaller runs during EVERY auto-update, not just uninstalls. It used to wipe coached sessions on every update. FIXED with the `${ifNot} ${isUpdated}` guard in build/uninstaller.nsh. Config (license, Riot ID) is always kept.
3. Vision models misread game HUDs regularly. Do not trust single-frame reads for anything consequential. Every accuracy problem (side, alive/dead, callouts, team direction, ability availability) was fixed with either deterministic client-side logic or strict prompt rules with a "when unsure, be general or silent" fallback. Specific-but-wrong is always worse than general-but-right.
4. Economy was un-gradeable as a category (the coach is banned from economy tips and trackers have no economy data). Replaced with Impact.
5. Caching too long makes fresh games look missing (users read staleness as bugs). Current TTLs: server matches 5 min, client 2 min, caches dropped on session end and Riot ID change. Match details and MVP results cache forever (immutable).
6. The bundled Inter font only has weights 400-800. Requesting 900 anywhere silently falls back to Arial.
7. HenrikDev mmr-history only covers recent comp games (roughly the current act), so lifetime RR tracking is not possible; the rank graph filters placements and act-reset jumps and sums per-game RR changes instead of subtracting elo endpoints.
8. The similarity gate was too strict at match length; important advice must be repeatable. But the fix (a 60-second-only window) overcorrected: after a minute the model could repeat itself verbatim and players saw frequent duplicate tips. The balance that works (2.2.0): verbatim wording never repeats, near-identical wording never follows the previous tip back to back, moderate overlap is only blocked inside 60 seconds, so fresh-worded escalation ("still", "again", "third time now") still passes.
9. Play calls (default, split, stack) require evidence: banned in the first three rounds, and must cite match memory afterward.
10. Buy phase gets plans and setups only, never mid-round action tips.
11. A fixed 12-round halftime assumption is WRONG in swiftplay (4-round halves, sides swap at round 5): it used to force the first-half side across the swap, the worst possible side bug. Halftime math must be mode-aware and must not override the HUD in rounds where the mode (and therefore the half) is unknown.

## 5. Current known limitations (honest)

- The vision model still occasionally misreads the minimap (team direction) and exact locations; prompt rules mitigate but do not eliminate this.
- No code signing certificate yet, so SmartScreen shows "unknown publisher" on first install. This is the top remaining trust/distribution issue. The old Defender flag also lingers on machines that have not updated to 2.1.16+.
- Rank/RR data is comp-only and limited to the current act.
- macOS build config exists but the product is Windows-only in practice (capture helper is Windows-specific).
- Semver is now in effect: 2.2.0 is the first feature batch under it (mode-aware side math, anti-repeat gate, onboarding fundamentals question); fixes go to 2.2.x, the next feature batch to 2.3.0.

## 6. Release and ops process

- Client release: bump package.json version, commit "release: vX.Y.Z", push, then `npm run release` with a GH_TOKEN scoped to GhostCoach-releases (builds and publishes installer + blockmap + latest.yml). Then the public download on the main repo's release (asset name must stay exactly `GhostCoach.2.0.Setup.exe` so website links survive) is swapped to the same build.
- Backend deploys automatically on push to main; only client changes need a release.
- Server keys live in Railway env vars: AI_API_KEY (OpenRouter), AI_VISION_MODEL, GEMINI_API_KEY (audio), HENRIKDEV_API_KEY, Stripe keys, JWT_SECRET.
- The user-facing writing rule for this project: never use em or en dashes anywhere (tips, UI, docs); use commas instead.

## 7. Suggested next features (agreed roadmap candidates)

1. Weekly Coach Report (Monday report card: winrate, best/worst map, agent trends, one focus goal). Highest retention value.
2. Focus Goal pinned on the overlay per session, graded in the recap.
3. Clutch cards (gold "CLUTCH 1v3" pop when the engine detects a won 1vX, it already tracks alive counts and round outcomes).
4. Persistent per-player mistake profile that rides every prompt (the coach remembering you across weeks).
5. Film Room: post-match scrollable timeline of rounds, deaths, skull reviews, and the actual frames. The eventual headline feature.
6. Map setup sheets during agent select.
