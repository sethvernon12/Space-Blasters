// ============================================================================
// RM-21 purge workers (Slice B2). The scheduled maintenance-worker that drives the
// deletion mechanisms + external purge.
//   1. every deletion ENQUEUES external purge (storage+ai) via the trigger.
//   2. worker DRAINS the queue (mock purge → done).
//   3. worker RECONCILES straggler GoTrue users for child AND account receipts left
//      pending_auth_cleanup, then completes them.
//   4. worker SWEEPS orphan @child.invalid users (no children row), respecting a
//      grace window.
//   5. worker cleans expired pending_children; runs retention ONLY when opted in;
//      REPORTS dormant families (never auto-purges).
//   6. AUTH: no/!bad shared secret → 401.
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm21-workers-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, mintChildSession, adminClient, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECRET = 'maint_secret_rm21'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

console.log('Setup + serve maintenance-worker…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
// mint the children so they have GoTrue users to reconcile
const brielle = await mintChildSession(cfg, seth.client, CID.Brielle)
const theo = await mintChildSession(cfg, seth.client, CID.Theo)
const wren = await mintChildSession(cfg, dana.client, CID.Wren)

const envFile = path.join(root, 'supabase', '.env.rm21'); fs.writeFileSync(envFile, `MAINTENANCE_SECRET=${SECRET}\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const runWorker = async (body = {}, secret = SECRET) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/maintenance-worker`, { method: 'POST', headers: { 'X-Maintenance-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await runWorker({}, 'wrong').catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('maintenance-worker serving') : bad('function not ready')

const userExists = async (id) => !!(await admin.auth.admin.getUserById(id)).data?.user

try {
  // ---- 6 (first): AUTH — bad/no secret → 401 ----
  const noAuth = await runWorker({}, 'wrong-secret')
  noAuth.status === 401 ? ok('worker rejects a bad shared secret (401)') : bad(`auth: ${noAuth.status}`)

  // ---- 1. deletion ENQUEUES external purge (via the trigger) ----
  console.log('deletion enqueues external purge:')
  // purge_child directly (pg) — leaves the receipt pending_auth_cleanup + the GoTrue
  // user alive (a straggler for the reconcile step) and fires the enqueue trigger.
  await q(`select public.purge_child($1,$2,$3)`, [CID.Theo, uids.seth, uids.seth])
  const enq = (await q(`select kind, status from public.external_purge_queue where child_id=$1 order by kind`, [CID.Theo]))
  enq.length === 2 && enq.every((r) => r.status === 'pending') ? ok('purge_child enqueued storage+ai external-purge rows (pending)') : bad(`enqueue: ${JSON.stringify(enq)}`)

  // ---- 2. worker drains the external-purge queue (mock → done) ----
  console.log('worker drains external purge + reconciles child GoTrue straggler:')
  const theoUserBefore = await userExists(theo.uid)
  const w1 = await runWorker({})
  const enqAfter = (await q(`select status from public.external_purge_queue where child_id=$1`, [CID.Theo]))
  const theoReceipt = (await q(`select status from public.deletion_receipts where child_id=$1`, [CID.Theo]))[0]
  const theoUserAfter = await userExists(theo.uid)
  w1.status === 200 && enqAfter.every((r) => r.status === 'done') && theoUserBefore && !theoUserAfter && theoReceipt?.status === 'completed'
    ? ok('worker: external purge done (mock); straggler child GoTrue user deleted; receipt → completed')
    : bad(`drain/reconcile: w1=${JSON.stringify(w1.body?.external_purge)} enq=${JSON.stringify(enqAfter)} userBefore=${theoUserBefore} userAfter=${theoUserAfter} receipt=${theoReceipt?.status}`)

  // ---- 3. account reconcile: purge_account leaves parent+child users; worker cleans ----
  console.log('worker reconciles an account GoTrue straggler:')
  await q(`select public.purge_account($1,$2)`, [uids.dana, uids.dana]) // Wren + Dana, receipt pending_auth_cleanup
  const danaBefore = await userExists(uids.dana), wrenBefore = await userExists(wren.uid)
  const w2 = await runWorker({})
  const acctReceipt = (await q(`select status from public.account_deletion_receipts where parent_id=$1`, [uids.dana]))[0]
  !((await userExists(uids.dana))) && !((await userExists(wren.uid))) && danaBefore && wrenBefore && acctReceipt?.status === 'completed'
    ? ok('worker: account straggler — parent + child GoTrue users deleted; account receipt → completed')
    : bad(`account reconcile: acctReceipt=${acctReceipt?.status} w2=${JSON.stringify(w2.body?.account_reconcile)}`)

  // ---- 4. orphan sweep (FIXED grace, not caller-tunable) ----
  console.log('orphan @child.invalid sweep:')
  const orphan = (await admin.auth.admin.createUser({ email: `c_${uuid()}@child.invalid`, password: uuid() + uuid(), email_confirm: true })).data.user
  const wFresh = await runWorker({}) // fresh (< 1h) → protected, NOT swept
  const orphanKeptFresh = await userExists(orphan.id)
  await q(`update auth.users set created_at = now() - interval '2 hours' where id = $1`, [orphan.id]) // age past the 1h grace
  const wAged = await runWorker({})
  const orphanGone = !(await userExists(orphan.id))
  orphanKeptFresh && orphanGone && wAged.body?.orphans_swept >= 1
    ? ok('orphan sweep respects the fixed grace window (fresh kept), removes it once aged past the window')
    : bad(`orphan: keptFresh=${orphanKeptFresh} gone=${orphanGone} swept=${JSON.stringify(wAged.body?.orphans_swept)} wFresh=${JSON.stringify(wFresh.body?.orphans_swept)}`)

  // ---- 5. pending_children TTL + retention opt-in + dormant report ----
  console.log('pending cleanup / retention opt-in / dormant report:')
  await q(`insert into public.pending_children (parent_id, nickname, expires_at) values ($1,'Abandoned', now()-interval '1 hour')`, [uids.seth])
  // an OLD, exported deletion receipt eligible for retention shred
  const oldRid = (await q(`insert into public.deletion_receipts (child_id, parent_id, deleting_actor, disposition, receipt_hash, status, created_at, db_purged_at) values ($1,$2,$3,'{}'::jsonb,'oldh','completed', now()-interval '9 years', now()-interval '9 years') returning id`, [uuid(), uids.seth, uids.seth]))[0].id
  await q(`insert into public.receipt_exports (receipt_id, sink) values ($1,'external')`, [oldRid])
  const wNoRet = await runWorker({}) // retention OFF by default
  const stillThere = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [oldRid]))[0].n === 1
  const wRet = await runWorker({ retention: true }) // opt-in → shred
  const shredded = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [oldRid]))[0].n === 0
  const pendingCleaned = (await q(`select count(*)::int n from public.pending_children where nickname='Abandoned'`))[0].n === 0
  wNoRet.body?.retention === 'skipped (opt-in)' && stillThere && shredded && pendingCleaned && typeof wRet.body?.dormant?.count === 'number'
    ? ok(`retention is opt-in (kept without flag, shredded with it); pending_children TTL cleaned; dormant REPORTED (count=${wRet.body.dormant.count}, never auto-purged)`)
    : bad(`sweeps: skipped=${wNoRet.body?.retention} stillThere=${stillThere} shredded=${shredded} pendingCleaned=${pendingCleaned} dormant=${JSON.stringify(wRet.body?.dormant)}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-21 WORKERS: ${fails} FAIL ===` : '\n=== RM-21 WORKERS: ALL PASS (enqueue→drain; child+account reconcile; orphan sweep; retention opt-in; dormant report) ===')
process.exit(fails ? 1 : 0)
