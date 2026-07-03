# Phase 0 — Acceptance criteria (sign-off checklist)

Phase 0 = groundwork: everything local/in-repo, nothing touching accounts, money, or
any real database. We sign off against the list below; unchecked human-side items live
in `docs/NEEDS_HUMAN.md` and are **not** blockers for merging this branch, but ARE
blockers for starting Phase 2/3 work.

## A. Delivered in-repo (verify by running the commands in docs/RUNBOOK.md)

1. **Mastery schema locked.** `supabase/migrations/0001_mastery.sql` exists, is NOT
   applied anywhere, applies cleanly to a pristine PostgreSQL (`npm run migrate`), and
   models: per-(child, skill) Beta α/β with time-decay fields + `model_version`,
   misconception state, append-only `attempts` matching the game's REAL event payload
   (documented field-for-field in `docs/DATA_MAP.md`), and nullable not-yet-emitted
   signals (latency, retention, confidence, transfer) each commented with its source
   phase. The legacy-players → child keying assumption is stated in the file header.
2. **Deny-by-default isolation, tested.** RLS enabled + FORCED on every new table,
   keyed only to `auth.uid()`; zero grants to `anon`; mastery/misconception writable by
   no client; attempts append-only and consent ledger immutable even for
   `service_role`. Proven by `npm test` (10 leak tests) + `npm run validate` — all
   green locally and in CI on this branch.
3. **Taxonomy anchored to the real game.** `taxonomy/skills.json` covers all 23 stage
   keys in ladder order and all 13 emitted skill tags, with CCSS codes for every skill
   and explicit flagged gaps (`add2d2d`, `missBig`, `mult2d`). The validator re-parses
   `index.html` on every run, so curriculum drift fails CI.
4. **Data map.** `docs/DATA_MAP.md`: event payload ↔ stage ↔ CCSS ↔ `mastery.skill_id`,
   attribution rule (stageIndex, not tag), and the not-yet-emitted-signal table.
5. **Tooling.** One-command local run with zero external services (`cd db && npm
   install && npm test`); prod guard refuses any `supabase.co` URL; seeds/fixtures;
   schema validator; CI workflow runs game-syntax + taxonomy + migrate/validate/leak
   on every push/PR.
6. **Legal drafts (unsigned).** Privacy policy, terms, and the VPC flow spec exist
   under `legal/` with DRAFT banners, aligned with the hard rules and the locked
   `consent_ledger` schema, with [TODO]s marked for counsel.
7. **Observability scaffold.** Sentry wiring behind an empty `SENTRY_DSN` (no account),
   PII-scrubbing `beforeSend`, AI-call structured-log shape defined; `.env.example`
   lists every future secret with where it will live; no real secret anywhere in the
   repo or git history from this branch.
8. **Game untouched.** `index.html` has zero changes on this branch; production
   Supabase untouched (tooling cannot reach it by construction).

## B. Human-side Phase-0 items (tracked in docs/NEEDS_HUMAN.md — required before Phase 2/3)

9. Supabase DEV project created (separate from prod); prod point-in-time backups
   confirmed + restore steps documented.
10. Sentry account created and DSN pasted into env config.
11. Legal drafts reviewed by counsel; entity/jurisdiction decisions made.
12. Owner has run the leak test locally at least once and approved the branch merge.

**Sign-off:** owner replies "Phase 0 accepted" (or requests changes) after reviewing
this branch. Merging to main is the owner's action per CLAUDE.md.
