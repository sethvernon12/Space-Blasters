# Space Blasters — Math Mission

A voice-answered math space shooter for kids. **The entire app is one self-contained
`index.html`** — no build step, no dependencies, no secrets (the Supabase leaderboard uses a
public "publishable" key that is safe in client code).

## Deployment (already set up — do NOT redo)

The site is **live** and served by Vercel with the custom domain already attached.
`git push` to `main` auto-deploys production. Never create repos, run deploys, or touch
domains — to ship a change: edit `index.html`, verify, commit, push. That's it.

## Hard rules

1. Keep it **ONE self-contained `index.html`** at the repo root. No build step, no external
   CDNs/fonts/assets — the game must work offline from a single file.
2. **Never break the Supabase leaderboard or the voice-answer feature.** Do not touch the
   Supabase project itself. If a change would need a database change, write the SQL into
   `PENDING_DB.sql` and move on.
3. **Performance:** object counts are capped (particles ≤ 420, lasers ≤ 240, enemy shots
   ≤ 120, enemies ≤ 9). The bullet-firing loop is **wall-clock based** (`lastBulletT` in
   `update()`) so fire rate survives frame drops — preserve it. No `shadowBlur` in hot
   per-entity draw loops; big static art (skies, terrain, vignette) is cached to offscreen
   canvases.
4. **Verify every change before committing.**
   - *Syntax:* extract the `<script>` block and parse it:
     ```bash
     python3 -c "import re;open('/tmp/game.js','w').write(re.search(r'<script>(.*?)</script>', open('index.html').read(), re.S).group(1))"
     node --check /tmp/game.js
     ```
   - *Visuals:* after ANY visual change, capture and **critically review** screenshots
     before committing:
     ```bash
     cd tools && node screenshot.mjs   # → screens/ (gitignored): iPhone portrait,
                                       #   iPhone landscape & desktop × start/game/results
     ```
     `tools/` has a local Playwright install (`npm install` there if missing, then
     `npx playwright install chromium`). The script blocks all supabase.co requests so
     test runs can NEVER touch the real leaderboard. It drives the game via the
     `window.__mathblaster` hook (startGame / endGame / spawnBoss).
   Never leave the file broken. Commit after each completed, verified task; push only
   working states (push = production deploy).
5. Do **not** start database, account, login, assignment, tutor, or Stripe work here.

## Bigger picture (forward compatibility)

This game will later become one module inside a larger AI-native math hub (parent/child
accounts, AI-generated assignments, AI tutor, Stripe). Don't build any of that here — but
keep the seam clean: **every answered/missed problem flows through `recordAnswer(entry)`**,
which fills `game.log` and invokes an optional `window.onMathAnswer(evt)` callback with
`{text, correctAnswer, chosen, correct, missed, skill, stage, stageIndex, level, mode,
pilot, time}`. A host page can subscribe to stream results to an external system.

## Code structure (index.html, top to bottom)

- **CSS** — HUD chips, overlay screens (start / leaderboard / results), difficulty-mode
  selector, on-screen buttons (`#pauseBtn`, `#easeBtn`, `#bombBtn` for touch), and
  responsive `@media` rules for phones/tablets (incl. iOS safe areas).
- **HTML** — `<canvas id="game">`, HUD chip bar, and the three overlay screens.
- **Script** (one IIFE, `"use strict"`), in order:
  - **Canvas + resize** — DPR-aware (capped at 2), handles orientation changes.
  - **Sfx** — ZzFX presets + hand-built Web Audio explosions/beam, all through a master
    compressor. **Music** — generative ambient pad (no samples).
  - **Backend** — Supabase RPC wrapper (`signup_or_login`, `submit_score`,
    `get_leaderboard`). Name + 4-digit-PIN accounts; offline-tolerant.
  - **Game state** — `State` enum, `game` object, weapon-charge ladder (32 tiers),
    ranks, ship colors, WORLDS (per-boss landscape themes).
  - **Bosses / enemies / minions** — spawn + AI + projectile patterns. Fallen (missed)
    problems become tough "wraith" dreadnoughts with un-shootable ammo.
  - **Input** — dual mode, auto-detected (`touchMode`):
    - *Desktop:* Pointer Lock relative steering; type digits to answer; SPACE/B bomb,
      E ease-up, SHIFT/P pause, M mute.
    - *Touch:* drag anywhere to fly (relative), tap = bonus volley, tap the on-screen
      answer buttons to answer, second finger taps while steering; 💣/💙/⏸ buttons.
    - `tapAnswer()` hit-tests the canvas-drawn answer buttons (see `drawOptions`).
  - **Voice** — Web Speech API. Answer-aware matching (`answerHeard`,
    `freshAnswerMatch`): forgiving to mis-hears but can only ever fire the CORRECT
    answer. Merge-proof for fast back-to-back answers. Don't restructure lightly.
  - **Math curriculum** — `STAGES`: a research-based ladder (add within 5 → … →
    division), systematic fact queues + interleaved review + next-stage preview.
    `stageInfo(level)` maps a global level → stage. Stage boundaries are documented
    next to `MODES`.
  - **Difficulty modes** — `MODES` (Full Journey / Beginner / Intermediate / Advanced /
    Expert): each has `start` level, fast-`ramp` target (2 problems/level until then),
    `speedBase` + `combatBase` so problem fall speed and enemy pressure scale with
    progress *through the mode*, not the raw level. `easeUp()` (E key / 💙 button)
    steps back 3 levels; `registerMiss()` auto-eases after 3 misses in a row.
  - **update()** — simulation: ship, wall-clock bullet cadence, beams, boss/enemy AI,
    collisions, orbs/pickups, problem fall + miss handling.
  - **Rendering** — cached sky (gradient + nebulas + seeded planet/rings/moon) and
    scrolling terrain per world; twinkling starfield + shooting stars; additive
    particles with spark streaks; ships/bosses/enemies drawn procedurally
    (`drawEpicShip` is shared by the game and the start-screen carousel);
    `drawOptions` renders the tappable answer buttons; cached vignette.
  - **Results & report** — `summarize()`, `diagnose()` (best-fit placement),
    `buildResults()`, `buildReportText()` (human + JSON report for download).
  - **Ship carousel, account/leaderboard UI, button wiring, `loop()`.**

## Testing checklist for gameplay changes

- Desktop: launch → pointer locks → slide to fly → answer by voice/typing/click →
  boss fight → get hit → die → results → play again.
- Touch (DevTools device mode at minimum): drag to fly, tap answer buttons, 💣 and 💙
  buttons, pause/resume by tap, portrait + landscape.
- All five difficulty modes start at the right stage and ramp.
- Leaderboard still loads and submits (needs network).
