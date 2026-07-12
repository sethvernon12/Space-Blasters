// ============================================================================
// RM-33 storage-object purge (Phase 4 · U4). Departure/request deletion now purges
// the child's Storage OBJECTS (not just rows), with every SEC-U4 property:
//   U4a  no while-enrolled timer (uploads.expires_at is gone).
//   U4a+ purge_child deletes + COUNTS uploads rows (RESTRICT backstop) in the receipt.
//   U4b  CATALOG reconcile (read-only over storage.objects) → API-only delete → empty;
//        isolation (one child's prefix only); legal hold blocks at kernel AND worker;
//        self-calibrating blast-radius breaker.
//   U4c  durable result annex; reconcile_deletions_after_restore makes a completed
//        deletion SURVIVE a restore (resurrected object re-purged).
// LOCAL only. Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm33-storage-purge-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY } from './family.mjs'
import { blastRadiusDecision, CROSS_BUCKET_FLOOR } from '../../supabase/functions/_shared/blast-radius.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECRET = 'maint_secret_rm33'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId }

console.log('Setup + serve maintenance-worker…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)
await signInAs(cfg, A.parent.email)

// a minimal valid JPEG (SOI … EOI); the object just has to EXIST in the bucket catalog
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(40).fill(0x00), 0xFF, 0xD9])
const manifest = async (childId) => (await q(`select public.child_storage_purge_manifest('uploads', $1::uuid) m`, [childId]))[0].m
// storage objects persist across runs (applySchema resets Postgres, not the bucket) —
// clear a child's prefix so seeded counts are deterministic
const cleanPrefix = async (childId) => {
  const { data } = await admin.storage.from('uploads').list(childId, { limit: 1000 })
  const paths = (data ?? []).map((f) => `${childId}/${f.name}`)
  if (paths.length) await admin.storage.from('uploads').remove(paths)
}
// seed a REAL storage object under the child prefix; optionally record the uploads row
const seedObject = async (childId, withRow = true) => {
  const name = `${childId}/${uuid()}.jpg`
  const { error } = await admin.storage.from('uploads').upload(name, JPEG, { contentType: 'image/jpeg', upsert: true })
  if (error) throw new Error('storage upload failed (host→storage): ' + error.message)
  if (withRow) await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
                        values ($1::uuid,$2::uuid,'parent',$3,'image/jpeg',$4,true,'inbox')`, [childId, uids.seth, name, JPEG.length])
  return name
}

const envFile = path.join(root, 'supabase', '.env.rm33'); fs.writeFileSync(envFile, `MAINTENANCE_SECRET=${SECRET}\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const runWorker = async (body = {}, secret = SECRET) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/maintenance-worker`, { method: 'POST', headers: { 'X-Maintenance-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await runWorker({}, 'wrong').catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('maintenance-worker serving') : bad('function not ready')

try {
  // ---- U4a: the while-enrolled timer is gone ----
  const hasExpires = (await q(`select 1 from information_schema.columns where table_schema='public' and table_name='uploads' and column_name='expires_at'`)).length
  hasExpires === 0 ? ok('U4a: uploads.expires_at dropped — a child’s work is retained while enrolled (no timer)') : bad('expires_at still present')

  // ---- breaker unit test (the shared pure decision) ----
  const b1 = blastRadiusDecision({ childCount: 3, bucketTotal: 5, listedCount: 3 })
  const b2 = blastRadiusDecision({ childCount: 600, bucketTotal: 1000, listedCount: 600 })
  const b3 = blastRadiusDecision({ childCount: 3, bucketTotal: 5, listedCount: 9 })
  const b4 = blastRadiusDecision({ childCount: 3, bucketTotal: 3, listedCount: 3 })
  b1.proceed && !b2.proceed && b2.page && !b3.proceed && b4.proceed
    ? ok(`breaker: normal proceeds; cross-bucket runaway halts+pages; child-overflow halts; below-floor(${CROSS_BUCKET_FLOOR}) small family proceeds`)
    : bad(`breaker: ${JSON.stringify([b1, b2, b3, b4])}`)

  // ---- seed: Brielle 3 objects, Theo 2 objects (clean prefixes first) ----
  await cleanPrefix(CID.Brielle); await cleanPrefix(CID.Theo)
  for (let i = 0; i < 3; i++) await seedObject(CID.Brielle)
  for (let i = 0; i < 2; i++) await seedObject(CID.Theo)

  // ---- U4b: catalog reconcile — manifest is prefix-scoped to ONE child ----
  const man = await manifest(CID.Brielle)
  man.ok && man.child_count === 3 && (man.objects ?? []).length === 3 && man.objects.every((o) => o.startsWith(CID.Brielle + '/')) && man.legal_hold === false && man.bucket_total >= 5
    ? ok(`catalog reconcile: manifest = Brielle’s 3 objects only (bucket_total=${man.bucket_total}, hold=false)`)
    : bad(`manifest: ${JSON.stringify(man)}`)

  // ---- U4a+: purge_child deletes + counts uploads rows; enqueues external purge ----
  const pr = (await q(`select public.purge_child($1,$2,$3) r`, [CID.Brielle, uids.seth, uids.seth]))[0].r
  const rowsLeft = (await q(`select count(*)::int n from public.uploads where child_id=$1`, [CID.Brielle]))[0].n
  pr.ok && pr.disposition?.deleted?.uploads === 3 && rowsLeft === 0
    ? ok('purge_child: 3 upload rows deleted + counted in the immutable receipt (RESTRICT backstop)')
    : bad(`purge_child: uploads=${pr.disposition?.deleted?.uploads} rowsLeft=${rowsLeft}`)
  const enq = await q(`select kind, status from public.external_purge_queue where child_id=$1 order by kind`, [CID.Brielle])
  enq.length === 2 && enq.every((r) => r.status === 'pending') ? ok('deletion enqueued storage+ai external purge (pending)') : bad(`enq: ${JSON.stringify(enq)}`)

  // ---- U4b: worker deletes the OBJECTS (API) → prefix empty; Theo untouched ----
  const w1 = await runWorker({})
  const manAfter = await manifest(CID.Brielle)
  const stRow = (await q(`select status, result from public.external_purge_queue where child_id=$1 and kind='storage'`, [CID.Brielle]))[0]
  const theoStill = await manifest(CID.Theo)
  w1.status === 200 && manAfter.child_count === 0 && stRow.status === 'done' && stRow.result?.objects_purged === 3 && theoStill.child_count === 2
    ? ok('worker: Brielle prefix emptied via Storage API (result.objects_purged=3); Theo’s 2 objects untouched (isolation)')
    : bad(`drain: after=${manAfter.child_count} stRow=${JSON.stringify(stRow)} theo=${theoStill.child_count}`)

  // ---- legal hold blocks at the KERNEL (no receipt, objects retained) ----
  await q(`insert into public.legal_holds (child_id, reason, placed_by) values ($1,'rm33-hold',$2)`, [CID.Theo, uids.seth])
  const ph = (await q(`select public.purge_child($1,$2,$3) r`, [CID.Theo, uids.seth, uids.seth]))[0].r
  const manTheo = await manifest(CID.Theo)
  const theoRows = (await q(`select count(*)::int n from public.uploads where child_id=$1`, [CID.Theo]))[0].n
  ph.ok === false && ph.error === 'legal_hold' && manTheo.legal_hold === true && manTheo.child_count === 2 && theoRows === 2
    ? ok('legal hold (kernel): purge_child refuses; manifest.legal_hold=true; rows + objects retained')
    : bad(`hold kernel: ${JSON.stringify(ph)} manHold=${manTheo.legal_hold} count=${manTheo.child_count} rows=${theoRows}`)

  // ---- legal hold ALSO blocks at the WORKER (defense-in-depth) ----
  await q(`insert into public.external_purge_queue (child_id, kind) values ($1,'storage') on conflict (child_id, kind) do update set status='pending', attempts=0`, [CID.Theo])
  await runWorker({})
  const theoAfter = await manifest(CID.Theo)
  const theoQ = (await q(`select status, last_error from public.external_purge_queue where child_id=$1 and kind='storage'`, [CID.Theo]))[0]
  theoAfter.child_count === 2 && theoQ.status === 'pending' && /legal_hold/.test(theoQ.last_error || '')
    ? ok('legal hold (worker): held child NOT purged (row stays pending, last_error=legal_hold)')
    : bad(`worker hold: count=${theoAfter.child_count} q=${JSON.stringify(theoQ)}`)

  // ---- U4c: a completed deletion SURVIVES a restore ----
  await seedObject(CID.Brielle, false)                 // simulate PITR bringing an object back
  const manR1 = await manifest(CID.Brielle)
  const rec = (await q(`select public.reconcile_deletions_after_restore() r`))[0].r
  await runWorker({})
  const manR2 = await manifest(CID.Brielle)
  manR1.child_count === 1 && rec.ok && manR2.child_count === 0
    ? ok(`restore survives: a resurrected object under a deleted child was re-purged (reconcile requeued=${rec.requeued})`)
    : bad(`restore: before=${manR1.child_count} rec=${JSON.stringify(rec)} after=${manR2.child_count}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-33 STORAGE PURGE: ${fails} FAIL ===` : '\n=== RM-33 STORAGE PURGE: ALL PASS (catalog reconcile; API-only object delete; isolation; legal hold kernel+worker; breaker; restore-survives) ===')
process.exit(fails ? 1 : 0)
