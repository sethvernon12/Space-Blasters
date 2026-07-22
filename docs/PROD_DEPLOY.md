# PROD_DEPLOY — Production deploy runbook (Brielle launch)

The exact, ordered steps to take the hub LIVE for one real homeschool family once production accounts exist.
**Guardrails (standing):** never touch the Academy prod DB (`academy-prod`, ref `pithcnslzifhcrfojwdl`); never merge to `main` without founder approval; the isolation smoke MUST show zero cross-child/cross-family leaks before real data lands. All secrets per `docs/PROD_ENV.md`.

## 0. Prereqs (accounts to provision first)
- **Vercel** project for the hub (build cmd already in `vercel.json`: `npm --prefix hub install && npm --prefix hub run build`).
- **A FRESH Supabase project** for the family (NOT `academy-prod`). Record its ref as `<PROD_REF>`.
- **Stripe LIVE** account + a $1 one-time Price (→ `STRIPE_CONSENT_PRICE_ID`) + a webhook endpoint (→ `STRIPE_WEBHOOK_SECRET`).
- **Google OAuth** client (id + secret) for Supabase Auth.

## 1. Set environment (per `docs/PROD_ENV.md`)
- Supabase Edge secrets: `supabase secrets set --project-ref <PROD_REF> STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… STRIPE_CONSENT_PRICE_ID=… MAINTENANCE_SECRET=… GRADE_WORKER_SECRET=… RECEIPT_SINK_SECRET=… RECEIPT_EXPORT_SINK=… RECEIPT_EXPORT_KEY=… EMAIL_PROVIDER_URL=… EMAIL_PROVIDER_KEY=… HUB_ALLOWED_ORIGINS=https://<prod-hub-origin>`. (`SUPABASE_URL`/`ANON`/`SERVICE_ROLE` are auto.) **Leave `AI_PURGE_STUB_*` UNSET.** `AI_PURGE_URL`/`AI_PURGE_KEY` only when AI grading lands (deferred from first launch).
- Vercel env (Production): `VITE_SUPABASE_URL=https://<PROD_REF>.supabase.co`, `VITE_SUPABASE_PUBLISHABLE_KEY=<anon>`. **Do NOT set `VITE_ALLOW_DEV_SIGNIN`** (must be absent/false → the dev switcher + synthetic creds tree-shake out; enforced by step 5's scan gate).

## 2. Apply the migration chain to the FRESH PROD DB
The chain is `0001→0054` (55 files as of this writing — verify contiguity: `ls supabase/migrations/*.sql | wc -l` and no numbering gaps). It applies clean from empty (proven locally, isolation suite green).
```bash
supabase link --project-ref <PROD_REF>          # confirm you are NOT on academy-prod
supabase db push                                 # applies supabase/migrations/* in order
```
Verify: `supabase migration list --project-ref <PROD_REF>` shows 0001…0054 all applied, no gaps.

## 3. Deploy edge functions
```bash
supabase functions deploy --project-ref <PROD_REF>   # deploys supabase/functions/*
```

## 4. Configure Auth + Stripe (dashboard)
- Supabase Auth → Providers → Google: paste the client id + secret; set the Site URL / redirect to the prod hub origin.
- Stripe → Webhooks: point the endpoint at `https://<PROD_REF>.functions.supabase.co/stripe-webhook`; its signing secret must equal `STRIPE_WEBHOOK_SECRET`.

## 5. Deploy the hub + run the bundle scan gate
```bash
# Vercel builds with VITE_ALLOW_DEV_SIGNIN unset. Locally verify the gate:
npm --prefix hub run build            # outDir = ./dist
bash hub/scripts/scan-prod-bundle.sh  # MUST print "CLEAN"; exits non-zero (fails the build) if a secret / the dev switcher leaked
```
Wire `hub/scripts/scan-prod-bundle.sh` into the Vercel build (post-build) or CI so a leaked switcher/secret fails the deploy.

## 6. Arm the deletion-lifecycle worker (pg_cron + pg_net + MAINTENANCE_SECRET)
The worker (`maintenance-worker`) is deployed but **runs nothing until scheduled** (external-purge drain, GoTrue reconcile, orphan sweep, pending-children TTL). Store the secret in Supabase Vault and schedule via pg_cron → pg_net:
```sql
-- run in the PROD SQL editor once MAINTENANCE_SECRET is set as a Vault secret named 'maintenance_secret'
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('maintenance-worker', '*/15 * * * *', $$
  select net.http_post(
    url     := 'https://<PROD_REF>.functions.supabase.co/maintenance-worker',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'X-Maintenance-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'maintenance_secret')),
    body    := '{}'::jsonb) $$);
```
(The `grade-worker` cron is analogous with `GRADE_WORKER_SECRET` — **defer it**; AI handwriting-grading is out of the first launch.) Departure/request deletion needs NO cron — it runs synchronously via `delete-child`/`delete-account` → `purge_child`.

## 7. Confirm the deletion covenant's real sinks (A4 — code already real)
- **Storage:** `_shared/purge-external.ts:purgeStorage` calls the real Storage API (`service.storage.from(UPLOADS_BUCKET).remove(...)`), verifies zero leftover via a manifest RPC. Real destination (active once uploads exist).
- **AI provider:** `purgeAiProvider` does a real `fetch(AI_PURGE_URL, …)` when configured; when `AI_PURGE_URL` is unset it returns a safe mock (ZDR providers retain nothing — defense-in-depth). Real destination when AI lands.
- Every deletion enqueues `(child_id,'storage'|'ai')` into `external_purge_queue` via an AFTER-INSERT trigger on `deletion_receipts`; the worker (step 6) drains it.

## 8. Smoke test
```bash
SMOKE_URL=https://<PROD_REF>.supabase.co SMOKE_ANON=<anon> node db/scripts/smoke-test.mjs
```
Verifies (against the target DB + deployment): a parent can sign in; the $1 consent charge records consent; a child records an attempt; the parent sees the summary; and **cross-child/cross-family isolation holds (zero leaks)**. Green = go. (The OAuth + live-Stripe legs require the real Google/Stripe config from steps 4; the DB isolation + attempt + summary legs run against any target and are the hard gate.)

## 9. Post-deploy
- Confirm the family can reach a populated child hub; delete-child produces a receipt and purges (dry-run on a throwaway child first).
- Watch logs for zero child PII (NFR-06). Keep `main` untouched — the hub ships from the release branch until the founder merges.
