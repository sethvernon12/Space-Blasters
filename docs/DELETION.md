# Deletion, retention & the PITR restore runbook

The child-data deletion lifecycle: revocation → hard delete, one deletion path,
finite retention, and how a point-in-time restore must not resurrect deleted
children (or destroy the proof). Governed by `docs/ONE_PAGE.md` > `docs/SPEC.md`;
implements HARD RULE #6 + COPPA 312.10.

## One deletion path (never a second bespoke one)
Everything routes through **`purge_child`** (migration 0018):
- **Parent removes one child** — `delete-child` Edge fn → `purge_child`.
- **Parent deletes the whole account** — `delete-account` → `purge_account` (0019),
  which loops `purge_child` over every child, deletes the parent's operational
  rows, tombstones the parent's authored messages, and writes an immutable
  account receipt. Then it deletes the child GoTrue users **and the parent's own**.
- **Dormant/lapsed family (lifecycle)** — `list_dormant_families(cutoff)` (0019)
  identifies them; the scheduled sweep routes each through `purge_account`. *(The
  scheduler itself is ops — a pg_cron job wired at deploy, like the reconcile drain.)*

Disposition per table lives in `0018` (hard-delete child-private; tombstone
child/parent-authored shared messages; retain `consent_ledger`/`audit_log`/
`stripe_events` as de-FK'd evidence). Receipts are immutable, hash-chained
(advisory-lock-serialized), and **opaque** — the nickname is embedded only at
download/display time, never stored. Chaining: child receipts (`deletion_receipts`)
chain among themselves; an account receipt (`account_deletion_receipts`) chains
onto the most-recent receipt of **either** kind. The two are deliberately not one
rigid line, so retention can shred an aged account receipt without breaking the
child chain's verifiability.

## Retention is NOT forever (COPPA 312.10)
Evidence is kept for a **defined window**, then shredded — `expire_retained_evidence()`
(0019), a scheduled sweep (ops). Windows live in **`retention_policy`**:

| evidence_kind | placeholder | note |
|---|---|---|
| consent_ledger | 7 years | VPC consent record |
| audit_log | 7 years | child-data access log |
| deletion_receipts | 7 years | **export first** (see PITR) |
| account_deletion_receipts | 7 years | **export first** |
| stripe_events | 2 years | payment idempotency |
| deletion_attempts | 30 days | rate-limit ledger |

> ⚠️ **LEG-05 (attorney):** these are **PLACEHOLDERS**, not legal advice. The
> attorney sets the binding numbers before any real family's evidence exists —
> `update public.retention_policy set retain_interval = … where evidence_kind = …`.

Safety invariants (tested in `rm20`):
- A `consent_ledger` row still referenced by a **live child** is never shredded.
- A deletion receipt is shredded **only after it is exported off-DB** (`receipt_exports`)
  — retention can never destroy the last replay source.

## Scheduled workers + external purge (B2)
`maintenance-worker` (Edge fn, `verify_jwt=false` + `X-Maintenance-Secret` shared
secret, fail-closed) is the system worker that DRIVES the mechanisms above. It is
invoked by a scheduler — **pg_cron** (via `pg_net` calling the function with the
secret) or the platform scheduler — wired at deploy; nothing runs it automatically
until then. Each pass, all best-effort/isolated:
1. **External purge drain** — every deletion enqueues `(child_id, 'storage'|'ai')`
   into `external_purge_queue` via an AFTER-INSERT trigger on `deletion_receipts`
   (covers child / account / dormant / PITR-replay paths). The worker leases rows
   (`claim_external_purge`, SKIP LOCKED), runs `_shared/purge-external.ts`
   (`purgeStorage` + `purgeAiProvider` — **fail-closed mocks** until Phase 4/5
   uploads+AI exist), and marks done/failed (`complete_external_purge`); failures
   retry next pass.
2. **GoTrue reconcile** — deletes straggler users for child (`list_pending_auth_cleanup`)
   and account (`list_pending_account_auth_cleanup`) receipts left `pending_auth_cleanup`,
   then completes them.
3. **Orphan sweep** — deletes `@child.invalid` users older than a grace window with
   no `children` row (a webhook that crashed after `createUser`).
4. **pending_children TTL** cleanup.
5. **Retention** — `expire_retained_evidence`, **opt-in only** (`body.retention:true`);
   destructive, gated behind the LEG-05 attorney numbers, OFF by default.
6. **Dormant** — `list_dormant_families(cutoff)`: **report only** (count). Auto-purge
   of dormant families is a deliberate later step, never automatic here.

Suggested schedule (deploy-time): drain+reconcile+orphan+pending every ~15 min;
retention monthly (once LEG-05 is set); dormant report weekly.

## Off-DB anchor + parent email
On completion, `delete-child`/`delete-account` call the fail-closed `_shared/notify.ts`:
`exportReceipt` (durable off-DB copy of the opaque receipt id + hash — the PITR
replay anchor) then `mark_receipt_exported`, and `emailReceipt` (the hash to the
parent as an external anchor). Both mock-by-default (no external side effect) and
use a real sink/provider only when explicitly keyed (`RECEIPT_EXPORT_SINK`,
`EMAIL_PROVIDER_URL`) — same doctrine as the AI gateway + Stripe.

## PITR restore runbook (do this after ANY point-in-time restore)
A restore to a point **before** a deletion resurrects the child **and** loses the
receipt — the DB alone can't tell you what was supposed to be gone. The off-DB
receipt log is the source of truth.

1. **Freeze** child-facing writes (or keep the app in maintenance) until step 3 completes.
2. **Enumerate** every completed deletion from the **off-DB receipt export** whose
   `db_purged_at` (or export timestamp) is **after** the restore target — these are
   the children/accounts that the restore wrongly brought back.
3. **Replay**: for each, re-run the same kernel — `purge_child(child_id, parent_id,
   system_actor)` (or `purge_account`). It is **idempotent**: a surviving receipt
   short-circuits (no second revoke); a resurrected child with no receipt is
   re-purged cleanly (proven in `rm20`). Then re-run `admin.deleteUser` for the
   captured `child_auth_user_id` / `parent_auth_user_id` on the receipt.
4. **Reconcile** GoTrue: sweep `@child.invalid` users with no `children` row and
   drain `list_pending_auth_cleanup()`.
5. **Verify**: 0 resurrected children remain; each replayed deletion has a receipt;
   run the isolation matrix.

Never hand-delete resurrected rows — always replay through `purge_child`, so the
disposition matrix, evidence retention, and receipt chain stay correct.

## Legal hold
`legal_holds` (service-only, 0018) is checked inside `purge_child`; a held child
blocks its own deletion **and** any `purge_account` that includes it (fail-loud).
Release is an operator action; refund/dispute webhooks never delete.
