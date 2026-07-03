# NEEDS HUMAN — actions only you (or with your assistant) can do

Per CLAUDE.md, none of these were done autonomously. Exact steps included.
(The companion list of what WAS done locally is in `docs/PHASE0_ACCEPTANCE.md` §A.)

## 1. Create the Supabase DEV project (blocks Phase 2/3, ~10 min)
1. supabase.com → your org → **New project** → name `space-blasters-dev`, region same
   as prod, generous password (store in a password manager).
2. Do **not** add any data. Note the project ref + URL.
3. Paste into your local `.env` (copy `.env.example`): `SUPABASE_DEV_URL`,
   `SUPABASE_DEV_PUBLISHABLE_KEY`.
4. When we're ready to apply `0001_mastery.sql` to DEV, I will show you the exact SQL
   and wait for your "yes" (it's a STOP item even for dev, since it's a real hosted DB).

## 2. Confirm production backups + document restore (~10 min, read-only)
1. supabase.com → project `oafovcrxdjoyaxsytyjg` → Database → Backups.
2. Confirm daily backups exist; note whether PITR is available on your plan (it's a
   paid add-on — enabling it costs money, so that's your call; recommended before
   Phase 3 when child data exists).
3. Screenshot/note the restore procedure and paste it into `docs/RUNBOOK.md` (I'll
   format it).

## 3. Create the Sentry account (free tier, blocks nothing until Phase 3)
1. sentry.io → create org + one project (Browser JavaScript).
2. Copy the DSN into Vercel env (`SENTRY_DSN`, `VITE_SENTRY_DSN`) — never into the repo.

## 4. Legal review (blocks public hub launch, not development)
1. Send the three files in `legal/` to your attorney: privacy policy, terms, VPC spec.
2. Decisions needed from you/counsel: legal entity + state; refund policy; arbitration
   y/n; free-tier VPC method; homework-photo retention window; unclaimed-legacy-player
   deletion window; chargeback-as-revocation policy.
3. Nothing gets published or "agreed to" by users until you say so.

## 5. GitHub Actions (2 min)
1. Check the Actions tab on sethvernon12/Space-Blasters — the `ci` workflow from this
   branch should have run. If Actions are disabled, enable them (Settings → Actions).

## 6. Approvals you may want to grant/deny on this branch (STOP items I did NOT self-approve)
- **New dev-dependencies** (CLAUDE.md gate #5): `pg` and `embedded-postgres` in
  `db/package.json` (dev-only, local tooling; embedded-postgres bundles real PostgreSQL
  binaries so the leak test runs with zero installs). Approve by merging, or tell me to
  swap to a Docker-based harness instead.
- **Merge this branch to main** — your action, after review.

## 7. Leftover from earlier session (1 min, optional)
- A test account ("Tester", PIN 1234, score 385) was accidentally submitted to the real
  leaderboard before the screenshot tool gained its supabase.co block. If you want it
  removed, that's a production DB write → tell me and I'll prepare the exact SQL for
  your approval, or delete it yourself in the Supabase dashboard (Table editor →
  players → delete the "Tester" row).

## Explicitly NOT done (per your instructions)
No accounts created; no migration applied to any real DB (not even staging); no
dashboard settings changed; nothing signed; no money spent; no real secrets anywhere.
