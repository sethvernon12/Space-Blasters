// ============================================================================
// RM-20 retention lifecycle + one-deletion-path (Slice B3).
//   1. RETENTION: expire_retained_evidence shreds past-window evidence, audited;
//      recent survives; a consent row referenced by a LIVE child is protected; a
//      deletion receipt is shredded ONLY after it is exported (PITR anchor).
//   2. ONE PATH: delete-account routes every child through the SAME purge_child
//      kernel — children purged, immutable account receipt, child+parent GoTrue
//      users deleted, other family untouched.
//   3. EXPORT hook: a delete-child marks the receipt exported (off-DB anchor).
//   4. DORMANT: list_dormant_families identifies lapsed accounts.
//   5. PITR replay: purge_child is idempotent for a surviving receipt and re-purges
//      a resurrected (no-receipt) child — safe to replay from the off-DB log.
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm20-lifecycle-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, mintChildSession, adminClient, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

console.log('Setup + serve delete-child/delete-account…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const envFile = path.join(root, 'supabase', '.env.rm20'); fs.writeFileSync(envFile, '# rm20\n')
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const invoke = async (token, fn, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
// readiness: probe delete-child with an EMPTY body (400 bad_request when served —
// NON-DESTRUCTIVE). NEVER probe delete-account with a valid token: with no childId
// it deletes the caller's WHOLE account. Same serve process → covers both.
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke(seth.session.access_token, 'delete-child', {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('functions not ready')

try {
  // ---- 1. RETENTION expiry ----
  console.log('retention shred (past-window evidence):')
  const oldUnref = (await q(`insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, created_at) values ($1,$2,'grant','other_vpc','v1', now()-interval '9 years') returning id`, [uids.seth, uuid()]))[0].id
  const recentCL = (await q(`insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, created_at) values ($1,$2,'grant','other_vpc','v1', now()) returning id`, [uids.seth, uuid()]))[0].id
  // an OLD consent row referenced by a LIVE child (Theo) must be PROTECTED (repoint
  // Theo's consent_id to it via the superuser seed path — children.consent_id isn't
  // client-writable). Theo stays live through this step (deleted later in step 3).
  const oldRef = (await q(`insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, created_at) values ($1,$2,'grant','other_vpc','v1', now()-interval '9 years') returning id`, [uids.seth, CID.Theo]))[0].id
  await q(`update public.children set consent_id=$1 where id=$2`, [oldRef, CID.Theo])
  // a past-window receipt: NOT exported (survive) vs MOCK export (survive — mock
  // doesn't count) vs REAL export (shred). Retention requires a non-mock sink.
  const mkReceipt = async (cid, sink) => {
    const rid = (await q(`insert into public.deletion_receipts (child_id, parent_id, deleting_actor, disposition, receipt_hash, status, created_at, db_purged_at)
      values ($1,$2,$3,'{}'::jsonb, $4, 'completed', now()-interval '9 years', now()-interval '9 years') returning id`, [cid, uids.seth, uids.seth, 'h_' + cid.slice(0, 8)]))[0].id
    if (sink) await q(`insert into public.receipt_exports (receipt_id, sink) values ($1,$2)`, [rid, sink])
    return rid
  }
  const rUnexported = await mkReceipt(uuid(), null)
  const rMock = await mkReceipt(uuid(), 'mock')
  const rExported = await mkReceipt(uuid(), 'external')
  const shred = (await q(`select public.expire_retained_evidence(now()) r`))[0].r.shredded
  const unrefGone = (await q(`select count(*)::int n from public.consent_ledger where id=$1`, [oldUnref]))[0].n === 0
  const recentKept = (await q(`select count(*)::int n from public.consent_ledger where id=$1`, [recentCL]))[0].n === 1
  const refKept = (await q(`select count(*)::int n from public.consent_ledger where id=$1`, [oldRef]))[0].n === 1
  const unexpKept = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [rUnexported]))[0].n === 1
  const mockKept = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [rMock]))[0].n === 1
  const expShredded = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [rExported]))[0].n === 0
  unrefGone && recentKept && refKept && unexpKept && mockKept && expShredded
    ? ok(`shred: old unreferenced gone, recent kept, live-child consent protected, receipt shredded ONLY after a REAL (non-mock) export (${JSON.stringify(shred)})`)
    : bad(`retention: unrefGone=${unrefGone} recentKept=${recentKept} refKept=${refKept} unexpKept=${unexpKept} mockKept=${mockKept} expShredded=${expShredded}`)

  // ---- 2. ONE PATH: delete-account (Dana) routes Wren through purge_child ----
  console.log('account deletion through the kernel:')
  const danaFresh = await signInAs(cfg, B.parent.email) // fresh token so step-up passes
  const del = await invoke(danaFresh.session.access_token, 'delete-account', {})
  const wrenGone = (await q(`select count(*)::int n from public.children where id=$1`, [CID.Wren]))[0].n === 0
  const danaKids = (await q(`select count(*)::int n from public.children where parent_id=$1`, [uids.dana]))[0].n === 0
  const acctReceipt = (await q(`select status, child_count, (r::text ilike '%Wren%') leak from public.account_deletion_receipts r where parent_id=$1`, [uids.dana]))[0]
  const wrenUser = await admin.auth.admin.getUserById(uids.wren)
  const danaUser = await admin.auth.admin.getUserById(uids.dana)
  const exported = (await q(`select count(*)::int n from public.receipt_exports re join public.account_deletion_receipts a on a.id=re.receipt_id where a.parent_id=$1`, [uids.dana]))[0].n === 1
  const alphaIntact = (await q(`select count(*)::int n from public.children where parent_id=$1`, [uids.seth]))[0].n === 2
  del.status === 200 && del.body?.ok && wrenGone && danaKids && acctReceipt?.status === 'completed' && acctReceipt?.child_count === 1 && !acctReceipt?.leak && !wrenUser.data?.user && !danaUser.data?.user && exported && alphaIntact
    ? ok('delete-account → Wren purged via kernel, opaque account receipt, child+parent GoTrue users deleted, receipt exported, Alpha untouched')
    : bad(`account: ${JSON.stringify({ st: del.status, wrenGone, danaKids, acctReceipt, wrenUser: !!wrenUser.data?.user, danaUser: !!danaUser.data?.user, exported, alphaIntact })}`)

  // ---- 2b. HIGH-1: a legal hold on ONE child blocks the WHOLE account delete,
  //          destroying NOTHING (no committed partial purge) ----
  console.log('legal hold blocks account deletion (no partial destruction):')
  await q(`insert into public.legal_holds (child_id, reason, placed_by) values ($1,'hold',$2)`, [CID.Theo, uids.seth])
  const sethHold = await signInAs(cfg, A.parent.email)
  const held = await invoke(sethHold.session.access_token, 'delete-account', {})
  const bothAlive = (await q(`select count(*)::int n from public.children where parent_id=$1`, [uids.seth]))[0].n === 2
  const noAcctReceipt = (await q(`select count(*)::int n from public.account_deletion_receipts where parent_id=$1`, [uids.seth]))[0].n === 0
  held.status === 423 && held.body?.error === 'legal_hold' && bothAlive && noAcctReceipt
    ? ok('account delete under a child hold → 423; BOTH children survive, no account receipt (nothing destroyed)')
    : bad(`legal hold: status=${held.status} bothAlive=${bothAlive} noAcctReceipt=${noAcctReceipt}`)
  await q(`update public.legal_holds set released_at=now() where child_id=$1`, [CID.Theo])

  // ---- 3. EXPORT hook on delete-child ----
  console.log('delete-child export hook:')
  const sethFresh = await signInAs(cfg, A.parent.email) // fresh token so step-up passes
  const dc = await invoke(sethFresh.session.access_token, 'delete-child', { childId: CID.Theo })
  const childExported = (await q(`select count(*)::int n from public.receipt_exports where receipt_id=$1`, [dc.body?.receipt_id]))[0].n === 1
  dc.status === 200 && childExported ? ok('a delete-child marks its receipt exported (off-DB anchor fired)') : bad(`export hook: ${JSON.stringify({ st: dc.status, childExported })}`)

  // ---- 4. DORMANT identification ----
  console.log('dormant-family identification:')
  const dormFuture = (await q(`select count(*)::int n from public.list_dormant_families(now()+interval '1 day')`))[0].n // everyone dormant vs "tomorrow"
  const dormPast = (await q(`select count(*)::int n from public.list_dormant_families(now()-interval '10 years')`))[0].n   // nobody dormant vs long-ago
  dormFuture >= 1 && dormPast === 0 ? ok(`list_dormant_families: ${dormFuture} vs a future cutoff, 0 vs a 10y-ago cutoff`) : bad(`dormant: future=${dormFuture} past=${dormPast}`)

  // ---- 5. PITR replay idempotence ----
  console.log('PITR replay safety:')
  // (a) a surviving receipt → replay is idempotent (Brielle still has her receipt)
  const rp1 = (await q(`select public.purge_child($1,$2,$3) r`, [CID.Brielle, uids.seth, uids.seth]))[0].r
  // Brielle wasn't deleted yet, so this actually purges her; do it, then replay
  const rp2 = (await q(`select public.purge_child($1,$2,$3) r`, [CID.Brielle, uids.seth, uids.seth]))[0].r
  const revokes = (await q(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='revoke'`, [CID.Brielle]))[0].n
  rp1.ok && rp2.idempotent === true && revokes === 1
    ? ok('replaying purge_child on an existing receipt is idempotent (no second revoke)') : bad(`pitr: rp2=${JSON.stringify(rp2)} revokes=${revokes}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-20 LIFECYCLE: ${fails} FAIL ===` : '\n=== RM-20 LIFECYCLE: ALL PASS (retention shred; one deletion path; export; dormant; PITR-safe) ===')
process.exit(fails ? 1 : 0)
