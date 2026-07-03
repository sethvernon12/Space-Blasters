# Verifiable Parental Consent (VPC) Flow — SPEC DRAFT (for legal + product review)

> **STATUS: DRAFT v0.1 (2026-07-03). Product/engineering spec of the COPPA consent flow
> that Phase 3c will implement, aligned with the `consent_ledger` schema already locked
> in `supabase/migrations/0001_mastery.sql`. Nothing here is live.**

## 1. Legal basis
COPPA (16 CFR Part 312) requires verifiable parental consent before collecting personal
information from a child under 13. FTC-recognized methods include a **monetary
transaction with a payment card** where the card system provides notice of the
transaction. Our primary method: the parent's **Stripe checkout** for the hub
subscription (or a $[TODO 0.50–1.00] verification charge for a free-tier parent
[TODO: decide whether free tier exists and how it verifies]).

## 2. Non-negotiable invariants (mirror CLAUDE.md hard rules)
1. **No child profile exists and no child data is stored until a consent GRANT row is
   recorded — and the database itself enforces this.** Child profiles and consent rows
   are SERVICE-ONLY writes (no client policy/grant), so a client can never forge a
   consent record or create a profile that skips consent; attempt logging is
   RLS-blocked unless the child carries an active consent link; and `consent_ledger`
   is append-only and immutable (trigger-enforced, even against service credentials).
2. Each ledger row records: `parent_id` (verified login), `child_id`, `action`
   (`grant` | `revoke`), `method` (`stripe_card_transaction` | `legacy_claim` |
   `other_vpc`), `policy_version`, `detail` (e.g., Stripe payment-intent id — never
   card data), `created_at`.
3. Revocation is a new `revoke` row and triggers the deletion pipeline (hard-delete
   across DB/Storage/CDN + processor purge instructions + deletion receipt).
4. A material privacy-policy change (anything expanding collection/use of child data)
   requires a **fresh grant** at the new `policy_version` before the child can continue.

## 3. The flow (Phase 3c)
```
Parent (Google sign-in, 18+ self-attestation)
  → reads short "what we collect from your child" notice (direct notice, plain language)
  → creates child profile DRAFT (nickname + grade band only; held in the parent's
    session, NOT persisted as a child row)
  → Stripe checkout (subscription or verification charge)
  → webhook: payment verified (signed, idempotent)
  → server (Edge Function, auth-scoped):
       1. insert children row
       2. insert consent_ledger GRANT row (method=stripe_card_transaction,
          policy_version=<current>, detail={stripe_pi:...})
       3. link children.consent_id
  → child profile becomes usable
```
Failure at any step = no child row, no child data.

### Direct notice (shown before checkout, emailed after)
Plain-language summary: what we collect from the child (nickname, math activity,
uploaded schoolwork), what we never collect (ads/trackers, audio, real-name
requirement), parent rights (view/export/delete/revoke), link to full policy, and the
version string being consented to.

## 4. Legacy players migration (Phase 3a) — `method = legacy_claim`
Existing production `players` rows (name + PIN, no email) predate accounts:
1. Each legacy row is imported as an **unclaimed** child (`parent_id NULL`) — invisible
   to every client by RLS; effectively frozen, no new data collection.
2. A parent claims it by (a) signing in with Google, (b) proving control of the legacy
   name+PIN, (c) completing standard VPC (§3). The claim writes a GRANT row with
   `method=legacy_claim` + the Stripe verification detail, sets `parent_id`, and links
   history.
3. Unclaimed rows after [TODO: 12 months] are deleted per retention policy.
4. Until the hub launches, the free game keeps operating as today (nickname + PIN
   leaderboard only, no email, no profile enrichment) — [TODO counsel: confirm the free
   game's current collection stays within COPPA's internal-operations/no-contact
   footing, and whether the under-13 leaderboard should hide nicknames entirely].

## 5. Revocation & deletion pipeline
Parent clicks "Delete child profile" (or emails us):
1. Append `revoke` row (immutable record that consent existed and ended).
2. Deletion job: hard-delete child rows (children/attempts/mastery/misconceptions/
   uploads), purge Storage objects + CDN, instruct AI providers/backups to purge
   [TODO: provider purge SLAs], anonymize any leaderboard rows.
3. Produce a deletion receipt (what classes were deleted, when, job id) to the parent.
4. Audit-log every step.

## 6. Edge cases for counsel
- Two parents/guardians disputing a profile [TODO].
- Tutor access: parent grant scope + revocation; tutors never consent for a child.
- Child turning 13: [TODO — re-notice? convert profile?].
- School/co-op purchasing on behalf of families (FERPA hat) [TODO].
- Chargeback on the consent transaction: treat as revocation? [TODO — proposed: freeze
  profile, notify parent, 30-day cure, then delete.]

## 7. COPPA checklist mapping
| COPPA requirement | Where satisfied |
|---|---|
| Direct notice to parent | §3 notice step + email |
| Online notice (privacy policy) | `legal/PRIVACY_POLICY.draft.md`, linked site-wide |
| Verifiable consent before collection | §2 invariant 1, §3 ordering, DB-enforced ledger |
| Parent review/delete rights | Privacy Policy §8 + §5 pipeline |
| No conditioning on excess data | nickname-only child profile; minimal fields |
| Confidentiality/security | RLS isolation + leak tests + audit log |
| Retention limits | Privacy Policy §9 |
| Safe-harbor/method documentation | this spec + immutable ledger |
