# RM-10 — DEV staging runbook (synthetic, non-public)

Stand up the hub at **theallaroundathleteacademy.com** against the **DEV** Supabase
project, seeded with **synthetic families only**, behind noindex + an access gate.
Nothing here touches prod or the live game.

- **DEV project:** `appplvbgyghlhrjcaagn` — the ONLY Supabase target.
- **PROD project:** `oafovcrxdjoyaxsytyjg` — **NEVER touched.** Every tool here hard-refuses it (`db/scripts/dev-config.mjs`).
- **Live game:** `smartergames.ai` — never touched. The hub's game tile links out to it; staging deploys the **hub only** (no `/play`).
- **Data:** synthetic families from `db/scripts/family.mjs` (Seth/Brielle/Theo/Rose/observer + Dana/Wren). **No real names, no real children (SEC-09).**
- **AI:** mock provider only (the gateway fails closed with no ZDR-signed provider). No provider key.
- **Review gate:** migrations `0001`–`0012` have passed the adversarial review passes (0003–0005→0006; 0007–0010→0011; 0011→0012). A final consolidated review before **real** families (RM-12) remains a SEC-08 gate.

---

## Secrets posture (what goes where)
| Secret | Lives in | Reaches a client? |
|---|---|---|
| DEV **anon / publishable** key | Vercel env `VITE_SUPABASE_PUBLISHABLE_KEY`; Supabase auto-injects to functions | Yes — safe by design (RLS is the floor) |
| DEV **service-role** key | **only** the local seed/verify shell env (`DEV_SUPABASE_SERVICE_KEY`) | **Never** — not in the bundle, not in any function |
| DEV **DB connection string** | **only** the local seed/verify shell env (`DEV_SUPABASE_DB_URL`) | **Never** |
| Access-gate passphrase | Vercel env `VITE_STAGING_GATE` | Bundled (soft gate — see below) |

Pre-deploy secret scan (blocks deploy on any hit): `git grep -nE "service_role|SUPABASE_SERVICE|sb_secret_|SERVICE_ROLE_KEY" -- hub/src supabase/functions` and a scan of the built `dist/` bundle. `hub/.env.local` is gitignored and not bundled.

---

## STEP 1 — migrations → DEV (via the DEV-pinned Supabase MCP)
Apply **only** `supabase/migrations/*.sql`, in order (the `supabase/local/*` files are local scaffolding and do NOT go to DEV):
```
0001_mastery  0002_attempt_context  0003_accounts  0004_teaching  0005_secure_yard
0006_hardening  0007_groups  0008_derivation_engine  0009_grading  0010_assignment_gen
0011_review_hardening  0012_hardening2
```
1. `list_migrations` on DEV → apply only what's missing (DEV may already hold 0001/0002 from Phase 2).
2. Prereqs the local scaffolding covers locally: ensure DEV has `public.players` + `pgcrypto` in `extensions` (apply a players stub if absent — `0001`'s FK needs it); seed the **23 skills** (data-only, the rows in `supabase/local/003_skills_seed.sql`) since it's reference data.
3. Apply each migration with `apply_migration` (DEV ref).

## STEP 2 — seed synthetic families → DEV
Export the DEV secrets in your shell (never committed), then seed onto the applied schema (no schema drop):
```
export DEV_SUPABASE_URL=…  DEV_SUPABASE_ANON_KEY=…  DEV_SUPABASE_SERVICE_KEY=…  DEV_SUPABASE_DB_URL=…
node -e "import('./db/scripts/family.mjs').then(m => m.seedFamily((await import('./db/scripts/dev-config.mjs')).devConfig()))"
```
(`seedFamily` mints the GoTrue users + seeds children/consent/grants; service key stays in the shell.)

## STEP 3 — Edge Functions → DEV
```
supabase functions deploy child-summary grade-work generate-assignment --project-ref appplvbgyghlhrjcaagn
```
`verify_jwt=true`; they use only `SUPABASE_ANON_KEY` + the forwarded caller JWT (auto-injected) — no service-role key.

## STEP 4 — hub → Vercel (theallaroundathleteacademy.com)
Build from this branch with Vercel env:
```
VITE_SUPABASE_URL           = <DEV project url>
VITE_SUPABASE_PUBLISHABLE_KEY = <DEV anon key>
VITE_STAGING_GATE           = <chosen passphrase>     # enables the access gate
```
`vercel.json` on this branch already: builds the hub only (no `/play`), SPA-rewrites, and sends `X-Robots-Tag: noindex`. Deploy, then bind the domain (DNS).

**Non-public:** `<meta robots noindex>` + `robots.txt` disallow-all + `X-Robots-Tag` header, plus the **passphrase gate** (`StagingGate.tsx`, shown only when `VITE_STAGING_GATE` is set). The gate is *soft* (the passphrase is in the bundle) — the real protections are synthetic-only data + noindex; the passphrase keeps the URL private. Upgrade to Vercel **Deployment Protection** if the plan includes it.

## STEP 5 — verify DEV (must pass before you call it up)
- **DB isolation + smoke:** with the DEV secrets exported, `node db/scripts/dev-verify.mjs` — seeds synthetic + asserts **0 cross-family leaks**, scope, cross-family write denied, proposal-behind-approval, and consent-revocation cuts access. (The full 7×7×3 matrix is proven locally by `family-b3-matrix` on the identical migrations.)
- **Browser smoke:** open the staging URL → pass the gate → sign in as each synthetic role → confirm the three cockpits render and the AI summary / grade-approve / assignment-deliver flows work against DEV.

---

## Rollback
- **Migrations / data:** DEV is disposable + synthetic → reset the DEV `public` schema (drop + re-apply from `0001`) or restore Supabase PITR. No real-user impact.
- **Hub:** Vercel keeps deploy history → one-click instant rollback to the prior deployment, or unbind the domain.
- **Edge Functions:** redeploy prior versions or delete.
- **Domain:** point away / take the project down. Because it's DEV + synthetic + non-public, taking it down is consequence-free.

## Founder actions (human-gated — I cannot self-do these)
1. Confirm/create the Vercel project + add `theallaroundathleteacademy.com` DNS.
2. Provide the **DEV** keys: project url, anon key, service-role key, DB connection string.
3. Set the Vercel env vars (STEP 4) incl. the chosen `VITE_STAGING_GATE` passphrase.
4. Give the explicit go — then I apply migrations (STEP 1), seed (2), deploy functions (3) + hub (4), and run verify (5).
