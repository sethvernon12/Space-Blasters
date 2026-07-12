# Runbook — backups, restore, and departure purge (Phase 4 · U4)

Governed by the **value-capture principle** (`docs/SPEC.md` §1) and **LEG-06 / LEG-12**.
Capture-and-retain is the default; **sensitivity governs protection strength, never
deletion speed**. A child's work is **retained while enrolled and backed up**. Deletion
fires on **family departure**, a **parental request**, and the **post-departure retention
schedule** — never a while-enrolled timer.

## 1. Backups are intentional

We back up child work on purpose — durability protects the child's learning history. A
restore is a normal recovery action, not a privacy hazard. The one obligation a restore
creates: a deletion that had already **completed** must not be **resurrected** by the
restore. Section 4 is how we guarantee that.

## 2. What deletes, and when

| Trigger | Path | Timing |
| --- | --- | --- |
| Parent removes a child (explicit **delete now**) | `delete-child` → `purge_child` | Immediate — DB rows now; storage objects on the next worker pass. Minus the records-law skeleton (below). |
| Parent deletes the account | `delete-account` → `purge_account` → `purge_child` per child | Immediate, same as above, for every child. |
| **Passive lapse** (entitlement expired / dormant family) | `list_dormant_families` → (scheduled) `purge_account` | After a **grace/archive window** (`retention_policy.child_work_departed_grace`) so a returning family resumes where they left off, then deletion. |
| Post-departure schedule | `retention_policy` windows per data class | Attorney-set (LEG-05/LEG-12). |

**Records-law skeleton (LEG-12, attorney-gated).** An explicit "delete now" is honored
immediately for the child's work / photos / learning data, **except** a minimal
compliance skeleton (attendance / hours / final grade) retained for the statutory floor
and disclosed honestly. The exact minimal set + floor is a **pre-real-families gate**
(LEG-05); the placeholders live in `retention_policy` (`records_law_skeleton`,
`child_work_departed_grace`) and are **inert** until the attorney sets the numbers —
`expire_retained_evidence` only shreds the evidence kinds it names, never these.

## 3. How the storage-object purge works (U4b)

Every deletion writes an immutable `deletion_receipts` row; an `AFTER INSERT` trigger
(0020) enqueues `external_purge_queue` rows (`storage`, `ai`). The `maintenance-worker`
drains the queue → `purgeStorage()`:

1. **Catalog reconcile** — `child_storage_purge_manifest()` READS `storage.objects` (the
   catalog) scoped to the one child prefix `{child_id}/`. Never backend enumeration;
   never a SQL delete on `storage.objects`.
2. **Prefix-shape guard** — the prefix is exactly one UUID + `/` (type-guarded in SQL,
   re-checked in the worker).
3. **Legal hold** — the manifest returns the child's active-hold flag; a held child is
   never purged (defense-in-depth on top of `purge_child`'s own hold gate).
4. **Blast-radius breaker** (self-calibrating, no magic per-child number):
   - per-child: delete **at most the child's own counted set** (the manifest count);
   - cross-bucket backstop: **halt + page** if this one child is **>25 % of the whole
     bucket** once the bucket is non-trivial (`CROSS_BUCKET_FLOOR`) — impossible for a
     legitimate child, catches a runaway / empty-prefix bug. Below the floor the exact
     per-child guard rules (a real family can be most of a near-empty bucket early on).
5. **API-only delete** — `storage.from('uploads').remove([...])`, batched, idempotent.
6. **Forward-recovery verify** — re-list the prefix; report `done` only when empty, else
   retry next pass. Never claim done on a partial purge.

The purge result (objects_purged, breaker decision) is recorded on the queue row
(`external_purge_queue.result`) as a durable technical annex; the parent-facing
`deletion_receipts` row is the honest receipt; `receipt_exports` anchors it off-DB.

## 4. After a PITR restore — make completed deletions survive

A restore can bring back storage objects (and DB rows) for a child whose deletion had
completed. Re-apply those deletions:

1. Restore the project to the target timestamp (Supabase PITR).
2. Confirm `deletion_receipts` / `account_deletion_receipts` are present (they are
   append-only; a completed receipt is the authority that the child was deleted).
3. Run the reconcile — re-arms external purge for **every** deletion receipt:
   ```sql
   select public.reconcile_deletions_after_restore();
   ```
4. Trigger a worker pass (`maintenance-worker`) — it re-drives `purgeStorage()` for each
   re-armed row, re-deleting any resurrected objects. Idempotent: children with nothing
   left resolve immediately (`empty`).
5. Verify: for a spot-check of deleted children,
   `select public.child_storage_purge_manifest('uploads', '<child_id>')` returns
   `child_count = 0`.

A completed departure-deletion is therefore **re-applied on restore, never resurrected**.

## 5. Invariants (what a reviewer checks)

- No while-enrolled deletion path exists (no `uploads.expires_at`).
- Storage deletion is **API-only**; SQL only ever **reads** `storage.objects`.
- A legal hold blocks the purge at both `purge_child` and the storage worker.
- The breaker cannot delete beyond one child's counted set; the cross-bucket backstop
  halts + pages on a runaway.
- A purge touches exactly one child's prefix — cross-child / cross-family untouched.
- `reconcile_deletions_after_restore()` + a worker pass re-empty every deleted child's
  prefix after a restore.
