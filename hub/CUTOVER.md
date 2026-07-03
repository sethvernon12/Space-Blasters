# Hub ↔ Game cutover (future, reversible) — NOT done in this milestone

This milestone builds the hub shell in `hub/` and changes **nothing** in production.
The live game is still the single root `index.html`, served by Vercel from `main` at
`smartergames.ai`, byte-identical. This note describes the eventual cutover so whoever
wires it (Cowork) has a reversible plan. **Do not perform any of this without explicit
owner approval.**

## Where things point today
- Root `index.html` — the live game, served at `/` (unchanged).
- `hub/` — a separate Vite/React app. Its Play tile and Practice link go to
  `GAME_URL` in `hub/src/lib/config.ts` (currently `https://www.smartergames.ai/`, i.e.
  the game at the domain root).
- `hub/` is listed in the root `.vercelignore`, so the current game deploy does **not**
  serve hub source. The hub is not deployed anywhere yet.

## The intended end state
- Hub becomes the front door at `/`.
- The game moves to a path, e.g. `/play`, and the hub's Play tile points there.
- "Back to Hub" from the game returns to `/` (browser Back already works because Play is
  a top-level link, not an iframe).

## A reversible way to get there (for Cowork to execute, owner-approved)
1. **Preview first.** Deploy `hub/` as its own Vercel preview (its own project/URL).
   Verify sign-in, tiles, and the Play link end-to-end on the preview. Nothing about the
   production game changes during this step.
2. **Serve the game at `/play`.** Add a rewrite/route so the existing root `index.html`
   is reachable at `/play` *in addition to* `/`. Confirm pointer-lock, Web Audio, and the
   mic still work there (they will — it's the same top-level document, just a different
   path). This is additive and reversible.
3. **Point the hub at `/play`.** Set `GAME_URL` (relative `/play`) and redeploy the hub
   preview; re-verify.
4. **Flip the root.** Make `/` serve the hub and `/play` serve the game, in one deploy.
   Keep the previous deployment pinned so a one-click Vercel **rollback** restores the
   game-at-root instantly.
5. **Rollback plan.** If anything regresses, roll back to the pinned game-at-root
   deployment (instant), or revert the routing change and redeploy. No data is involved;
   this is purely static routing.

## Hard constraints carried from CLAUDE.md
- The game stays a self-contained top-level document — **never** embed it in an iframe
  (breaks pointer lock, audio, and voice).
- Auth stays the existing name + 4-digit PIN via `signup_or_login` until the Phase-3
  Google/parent auth milestone; the hub stores its session under `sg_hub_account`
  (separate from the game's `mb_account`).
- No production cutover, domain change, or database change without explicit owner
  approval.
