# Privacy Policy — DRAFT (UNSIGNED / NOT IN EFFECT)

> **STATUS: DRAFT v0.1 (2026-07-03) FOR ATTORNEY REVIEW. Not published, not linked from
> the product, not legally effective. Bracketed [TODO] items require business/legal
> decisions. Written for the current free game AND the planned paid "math hub"
> (parent/child accounts); hub-only sections are marked (HUB).**

Policy version: `privacy-draft-2026-07` (this version string is what the consent ledger
records — see `legal/PARENTAL_CONSENT_SPEC.draft.md`).

## 1. Who we are
[TODO: legal entity name, state of formation, registered address] ("we", "us") operates
Space Blasters and the Smarter Games math hub at smartergames.ai. Contact:
[TODO: privacy@smartergames.ai], [TODO: postal address], [TODO: phone].

## 2. Our approach for children (COPPA)
Our services are used by children under 13. We follow the Children's Online Privacy
Protection Act (COPPA):
- We collect **the minimum data needed to run the service** and nothing more.
- (HUB) We do **not** create a child profile or store a child's data until a parent has
  given **Verifiable Parental Consent (VPC)**; the consent event is recorded in an
  immutable ledger (parent, child, method, policy version, timestamp).
- We show **no advertising** of any kind, no behavioral tracking, and we **never sell**
  or rent personal information.
- Parents can **review, export, and delete** their child's information at any time
  (Section 8).

## 3. What we collect
**Free game (today):**
- A self-chosen pilot **nickname** and a 4-digit PIN (stored only as a hash).
- Gameplay records: problems shown, answers chosen, correct/missed, difficulty stage,
  score, timestamps.
- We do NOT collect email, real name, date of birth, address, photos, or location in
  the free game.

**Math hub (HUB, planned):**
- Parent account: email and name via Google sign-in; billing handled by Stripe (we never
  see full card numbers).
- Child profile: **nickname** (we ask parents NOT to use legal names), grade band, and
  learning records (skills practiced, mastery estimates, assignments, graded work).
- Homework photos a parent uploads for grading: stored in private storage, location
  metadata (EXIF/GPS) stripped on upload, **deleted automatically after grading**
  [TODO: retention window, e.g., 30 days].

**Voice answers:** speech recognition for game answers runs **on the device** via the
browser's built-in engine. We never receive, store, or transmit audio recordings. If a
browser's speech engine processes audio in the cloud, that engine is the browser
vendor's service and is listed as a disclosed processor [TODO: confirm per-browser
disclosure language with counsel]; we do not use any speech API that persists audio.

**Automatically collected:** basic technical logs (IP address for security/rate
limiting, browser type, error reports). Error reports are scrubbed so they never
contain a child's data.

## 4. What we do NOT collect from children
No advertising identifiers, no third-party ad/analytics trackers, no precise location,
no contact lists, no free-text public chat, no persistent audio or video.

## 5. How we use information
To run the game and hub; to grade work and personalize practice; to show parents their
child's progress; to maintain leaderboards (children appear **only under nicknames**;
under-13 leaderboards are private/anonymized); for security and abuse prevention; to
meet legal obligations. **AI processing (HUB):** when we use AI providers to grade math
work or generate practice, we send **only the math work itself** (the problem, the
child's answer, skill tags) — never names, emails, photos containing faces, voice, or
other identifying details. Providers must contractually commit to **no training on our
data and zero data retention**.

## 6. Sharing — service providers only
We share data only with processors needed to run the service, each under a data
processing agreement:

| Processor | Purpose | Data |
|---|---|---|
| Supabase | database & storage hosting | account and learning records |
| Vercel | web hosting/CDN | technical request data |
| Stripe (HUB) | billing & consent verification | parent payment data (never the child's data) |
| [AI provider(s)] (HUB) | grading/tutoring | de-identified math work only |
| Sentry | error monitoring | scrubbed technical errors (no child PII) |
| [Email provider] (HUB) | parent notifications | parent email |

We never sell personal information. We disclose only if required by law, and we will
notify parents unless legally prohibited.

## 7. FERPA note (for school/co-op use)
If a school or teacher uses the hub with students, we act as a "school official" with a
legitimate educational interest under FERPA: education records remain under the
school's/parent's control, we use them only to provide the service, and we support
review/correction/deletion requests. [TODO: counsel to finalize school-use addendum.]

## 8. Parental rights & data control
A parent can, at any time: **view** everything stored about their child; **export** it
(portfolio/records download); **correct** it; **revoke consent and delete** the child's
profile. Deletion is a hard delete across database, storage, and CDN caches, includes
instructions to processors to purge, and produces a deletion receipt. Contact
[TODO: privacy email] or use the in-product controls (HUB).

## 9. Retention
| Data class | Retention |
|---|---|
| Free-game leaderboard records | until deletion is requested [TODO confirm] |
| Child learning records (HUB) | while the subscription/consent is active; deleted on revocation |
| Homework photos (HUB) | auto-deleted after grading [TODO window] |
| Audio | never stored |
| Consent ledger | retained as legal record of consent [TODO period] |
| Security logs | [TODO, e.g., 90 days] |

## 10. Security
Row-level isolation between families and between children enforced in the database and
covered by automated tests; encryption in transit and at rest; secrets held only in
managed environment configuration; access to child data logged in an append-only audit
log; least-privilege service access.

## 11. Breach notification
If a breach affects personal information, we will notify affected parents and
applicable regulators without undue delay [TODO: jurisdiction-specific timelines].

## 12. State privacy addenda
[TODO: counsel — CCPA/CPRA (California), VCDPA (Virginia), COPPA-plus state student
privacy laws (e.g., SOPIPA), and an EU/UK GDPR position if the product is offered
there.]

## 13. Changes to this policy
Material changes that expand what we collect from children require **fresh parental
consent** before they apply to a child (the consent ledger stores the policy version
each parent agreed to).

## 14. Contact
[TODO: entity name, address, privacy email, phone.]
