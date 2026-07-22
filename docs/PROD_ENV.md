# PROD_ENV — Production environment manifest

Every environment variable / secret the production app requires. **Completeness is proven by grep**: this file
covers 100% of the variables the code reads — the edge-function set is `grep -rhoE "Deno\.env\.get\(['\"][A-Za-z0-9_]+['\"]\)" supabase/functions/`, and the hub set is `import.meta.env.VITE_*` (resolved by `hub/vite.config.ts`). Dashboard-config secrets that prod needs but no code *reads* (Google OAuth, Stripe webhook endpoint) are listed at the end.

Legend — **Where**: `Supabase` = Edge Function secret (`supabase secrets set` / dashboard) · `Vite` = hub build-time var (Vercel env, baked into the client bundle at build) · `Dashboard` = set in a provider console, not read by code. **Class**: `SECRET` (never in the client bundle, never logged) · `public` (safe to ship in the client / URL).

## Supabase — Edge Function secrets (`Deno.env.get`)

| Var | Where | Class | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | Supabase (auto) | public | The project API URL; auto-injected into every Edge Function. |
| `SUPABASE_ANON_KEY` | Supabase (auto) | public | The publishable/anon key; RLS-scoped, safe client-side. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase (auto) | **SECRET** | Bypasses RLS. Edge functions only (never client). Every use re-filters by child_id in code. |
| `STRIPE_SECRET_KEY` | Supabase | **SECRET** | Stripe **LIVE** secret key — server-side Checkout (the $1 VPC consent charge) in `create-consent-checkout`. |
| `STRIPE_WEBHOOK_SECRET` | Supabase | **SECRET** | Verifies the Stripe webhook signature in `stripe-webhook` (signature-as-auth; the consent grant path). |
| `STRIPE_CONSENT_PRICE_ID` | Supabase | public | The Stripe Price id for the one-time $1 consent charge. |
| `MAINTENANCE_SECRET` | Supabase | **SECRET** | Shared secret authorizing the `maintenance-worker` (the deletion-lifecycle / retention sweep), invoked by pg_cron. |
| `GRADE_WORKER_SECRET` | Supabase | **SECRET** | Shared secret authorizing the `grade-worker` (async grading queue drain), invoked by pg_cron. |
| `RECEIPT_SINK_SECRET` | Supabase | **SECRET** | Shared secret authorizing the `receipt-sink` (anchors deletion receipts to the durable export). |
| `RECEIPT_EXPORT_SINK` | Supabase | public(url) | The durable destination URL the deletion receipt is exported/anchored to. |
| `RECEIPT_EXPORT_KEY` | Supabase | **SECRET** | Auth token for `RECEIPT_EXPORT_SINK`. |
| `AI_PURGE_URL` | Supabase | public(url) | The AI-provider delete/no-retain endpoint (child-data purge, HARD RULE #6/#9). Absent ⇒ mock (ZDR providers retain nothing). |
| `AI_PURGE_KEY` | Supabase | **SECRET** | Auth token for `AI_PURGE_URL`. |
| `EMAIL_PROVIDER_URL` | Supabase | public(url) | Transactional email send endpoint (graded / stuck / digest / streak notifications). |
| `EMAIL_PROVIDER_KEY` | Supabase | **SECRET** | Auth token for `EMAIL_PROVIDER_URL`. |
| `HUB_ALLOWED_ORIGINS` | Supabase | public | CORS allowlist for the Edge Functions (the prod hub origin). |

### DEV-ONLY (must NOT be set in prod)
`AI_PURGE_STUB_DEV`, `AI_PURGE_STUB_SECRET`, `AI_PURGE_STUB_FAIL_REF` — local/dev stubs for the AI-purge path. **Leave unset in prod** so the real `AI_PURGE_URL`/`AI_PURGE_KEY` (or the ZDR mock) is used.

## Hub — Vite build-time vars (`import.meta.env.VITE_*`, resolved in `hub/vite.config.ts`)

| Var | Where | Class | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Vite (Vercel) | public | Baked into the client bundle as `__SUPABASE_URL__`. The prod project URL. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vite (Vercel) | public | Baked in as `__SUPABASE_PUBLISHABLE_KEY__`. The publishable/anon key (RLS-scoped, safe client-side). |
| `VITE_ALLOW_DEV_SIGNIN` | Vite (Vercel) | public(flag) | **MUST be unset/`false` in prod.** When ≠ `'true'`, `ALLOW_DEV_SIGNIN=false` ⇒ the dev sign-in switcher + the synthetic accounts + the shared password tree-shake out of the bundle (proven by the A3 bundle scan). Set to `'true'` ONLY for a synthetic-data staging build. |
| `VITE_STAGING_GATE` | Vite (Vercel) | public(flag) | Optional staging gate flag. |

## Dashboard-config (required for prod; not read by app code)

| Item | Where | Class | Purpose |
|---|---|---|---|
| Google OAuth **Client ID** | Dashboard — Supabase Auth → Providers → Google | public | Enables Google sign-in for parents. |
| Google OAuth **Client Secret** | Dashboard — Supabase Auth → Providers → Google | **SECRET** | The OAuth exchange secret (stored in Supabase Auth, never in code). |
| OAuth redirect / Site URL | Dashboard — Supabase Auth → URL config | public | The prod hub origin as the allowed redirect. |
| Stripe **Webhook endpoint** | Dashboard — Stripe → Webhooks | public | Points Stripe at the `stripe-webhook` function URL; its signing secret is `STRIPE_WEBHOOK_SECRET` above. |
| Stripe LIVE **Publishable key** | — | public | *Not currently read by code* — the consent flow uses server-side Stripe Checkout (`STRIPE_SECRET_KEY`), so the client redirects to a Stripe-hosted page and needs no publishable key. List here only if client-side Stripe.js is added later. |

## Completeness check (reproduce)
```bash
# edge-function env vars the code reads (must all appear above):
grep -rhoE "Deno\.env\.get\(['\"][A-Za-z0-9_]+['\"]\)" supabase/functions/ | sed -E "s/.*get\(['\"]//;s/['\"].*//" | sort -u
# hub build-time vars:
grep -rhoE "VITE_[A-Za-z0-9_]+" hub/src hub/vite.config.ts | sort -u
```
As of migration chain `0001→0053`: **19 edge-function vars + 4 hub `VITE_*` vars** are read by code; all are listed above (3 `AI_PURGE_STUB_*` are dev-only).
