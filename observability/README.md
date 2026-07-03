# Observability — Sentry scaffolding (Phase 0: wiring only, NO account yet)

Status: **placeholder-wired**. No Sentry account or DSN exists yet (creating one is on
`docs/NEEDS_HUMAN.md`). Everything reads `SENTRY_DSN` from environment config and is a
**no-op while the DSN is empty**, so this can merge safely long before the account
exists.

## Rules baked into these snippets (CLAUDE.md: never let error monitoring capture child PII)
- `sendDefaultPii: false`, no session replay, no user identifiers beyond an opaque id.
- A `beforeSend` scrubber strips anything that looks like a nickname, email, JWT, or
  request body before an event leaves the process.
- Structured AI-call logs record: task, model, tokens, cost, latency, and an **opaque**
  child scope id — never nickname/name/free text.

## Where each snippet goes
| file | used by | when |
|---|---|---|
| `sentry-browser.js` | the Vite-built hub front end (and the game once it becomes a lazy-loaded chunk) | Phase 3 |
| `sentry-edge-function.ts` | every Supabase Edge Function | first Edge Function (Phase 3) |

The single-file game (`index.html`) is deliberately NOT wired: it must stay
self-contained/offline-capable with no external CDNs (game hard rule #1). Game errors
become visible when it is served inside the hub shell in Phase 3.

## Turning it on later (human steps, see NEEDS_HUMAN.md)
1. Create the Sentry org/project (free tier is fine to start).
2. Paste the DSN into Vercel env (`SENTRY_DSN`, `VITE_SENTRY_DSN`) and Supabase Edge
   Function secrets — never into the repo.
3. Deploy a preview; confirm a thrown test error arrives scrubbed (no PII fields).
