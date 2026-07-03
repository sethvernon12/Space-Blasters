# Phase 2 — per-child history + skill map: status, acceptance, rollback

Everything below ran against LOCAL ephemeral Postgres only. Nothing hosted was
created, connected to, or applied. The recording feature flag is OFF everywhere.

## Acceptance checklist (spec ↔ evidence)

| criterion | where proven |
|---|---|
| event-sourced: append-only attempts, mastery = recomputable projection | migration triggers + `npm run reconcile` (replays log through `contracts/mastery.mjs`, diffs projection — exact) |
| idempotency: client uuid + UNIQUE, insert-or-ignore, mastery only for inserted rows | RPC `on conflict do nothing` + leak test "replay is a no-op" (0 inserted / 3 duplicates) |
| atomic write: one SECURITY DEFINER RPC, insert + mastery in one tx | `record_attempts` (plpgsql body = single transaction) |
| stable child key (children.id; legacy_player_id a pointer) | schema; RPC resolves players.id → children.legacy_player_id |
| auth-timing: name+PIN verified server-side; no client-supplied child id; RLS deny-by-default | RPC + leak tests "forgery" (batch child ids provably ignored) |
| skill integrity: FK + taxonomy validator re-parses index.html | attempts.skill_id FK; stage/tag agreement check; `npm run validate` |
| rich primitives: response_ms, input_method, asr_confidence, 'invalid', sessions, standard_code snapshot | schema + game emits responseMs/inputMethod/asrConfidence per answer (verify-recording shows real values per method) |
| evidence not labels: slip/guess/misconception never client-baked | RPC rejects those result values from clients (leak test) |
| multi-channel mastery, "mastered" = conjunction incl. transfer gate | `contracts/learning.mjs` masteredGates/isMastered (game can never satisfy transfer) |
| flag OFF byte-identical | `tools/verify-recording.mjs`: zero recording network calls, no IndexedDB, log/report/leaderboard unchanged |
| fail-open recording | same tool: network aborted → RPC attempted, rows stay queued, game completes normally |
| pure tested updateMastery | `contracts/mastery.mjs` + `db/scripts/mastery-test.mjs` (26 tests: bounds, monotone-vs-decayed-prior, decay golden, invalid no-op, purity, replay determinism) |
| reconciliation as CI gate | `.github/workflows/ci.yml` runs `npm run reconcile` |
| extended leak test | 19 DB tests: writes, cross-family, sibling, tutor scope + revocation, service-role, interim keying, PIN brute-force lockout, rate caps, consent gate |
| CHECK constraints | counts ≥ 0, correct ≤ attempts, asr 0..1, response_ms ≥ 0, mastery generated in (0,1) |

## Commands (all local; see docs/RUNBOOK.md)
```bash
cd db && npm run migrate && npm run validate && npm test && npm run reconcile
cd tools && node verify-recording.mjs && node screenshot.mjs
```

## Rollback plan
- **Now (nothing hosted, nothing merged):** delete/abandon the branch — zero footprint.
- **If merged to main later:** the game ships with `FEATURE_RECORD_ATTEMPTS = false`;
  behavior is verified identical to today, so rollback = `git revert` of the merge
  commit (pure code revert, no data implications — no DB exists to roll back).
- **If later applied to the hosted DEV project:** dev is disposable pre-production —
  reset the dev database and re-apply migrations from the repo (the single source of
  truth). No production application is planned until Phase 3 review.
- **Kill-switch once live (Phase 3+):** the flag stays server-controllable in spirit —
  turning recording off client-side stops all writes; revoking EXECUTE on
  `record_attempts` from `anon` stops them server-side instantly without touching data.

## Known cosmetic nit (pre-existing, not Phase 2)
Boss nameplate text can clip at the screen edge while the boss glides in from an
extreme; the HP bar itself is clamped on-screen. Tracked for the next visual pass.
