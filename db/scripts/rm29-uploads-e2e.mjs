// Phase 4 · U1 — uploads storage + schema + CROSS-FAMILY ISOLATION (the gate).
// LOCAL only. The private bucket, the child-scoped uploads table + RLS, and the two
// write RPCs (record_upload / set_upload_status). Run (stack up):
//   eval "$(supabase status -o env)"; node db/scripts/rm29-uploads-e2e.mjs
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId, WREN = B.children.wren.childId
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

console.log('Setup + roles…')
await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const rose = await signInAs(cfg, A.tutor.email)       // granted tutor for Brielle
const obs = await signInAs(cfg, A.observer.email)     // view-only grant (can_write=false)
const rec = (c, child, path, ct = 'image/jpeg', bytes = 1048576, note = null) =>
  c.rpc('record_upload', { p_child_id: child, p_storage_path: path, p_content_type: ct, p_byte_size: bytes, p_note: note })
const P = (child) => `${child}/${crypto.randomUUID()}.jpg`

try {
  // ---- parent records an upload for their child ----
  const { data: r1 } = await rec(seth.client, BRIELLE, P(BRIELLE), 'image/jpeg', 1048576, 'page 1')
  r1?.ok && r1.upload_id ? ok('parent records an upload for their child') : bad(`record: ${JSON.stringify(r1)}`)
  const row = (await q(`select status,exif_stripped,uploader_role,uploaded_by,note, (expires_at > now()+interval '29 days' and expires_at < now()+interval '31 days') as exp_30d from public.uploads where id=$1`, [r1.upload_id]))[0]
  row.status === 'inbox' && row.exif_stripped === false && row.uploader_role === 'parent' && row.uploaded_by === seth.uid && row.exp_30d && row.note === 'page 1'
    ? ok('row: status=inbox, exif_stripped=false (U2 verifies), role DERIVED=parent, expires ~30d, note stored') : bad(`row: ${JSON.stringify(row)}`)
  // parent reads it back through RLS
  const { data: seen } = await seth.client.from('uploads').select('id').eq('child_id', BRIELLE)
  ;(seen ?? []).some((u) => u.id === r1.upload_id) ? ok('parent reads their child’s inbox (RLS)') : bad('parent cannot read own upload')

  // ---- validation (fail-closed) ----
  const { data: vType } = await rec(seth.client, BRIELLE, P(BRIELLE), 'application/pdf')
  vType?.error === 'bad_type' ? ok('non-image rejected (bad_type; PDF deferred)') : bad(`type: ${JSON.stringify(vType)}`)
  const { data: vSize } = await rec(seth.client, BRIELLE, P(BRIELLE), 'image/jpeg', 11 * 1048576)
  vSize?.error === 'bad_size' ? ok('oversized (>10MB) rejected (bad_size)') : bad(`size: ${JSON.stringify(vSize)}`)
  const { data: vPath } = await rec(seth.client, BRIELLE, `${WREN}/sneaky.jpg`)  // path not namespaced under Brielle
  vPath?.error === 'bad_path' ? ok('cross-child object path rejected (bad_path)') : bad(`path: ${JSON.stringify(vPath)}`)

  // ---- tutor grants: can-write tutor may upload; view-only may not ----
  const roseWrite = (await q(`select can_write from public.tutor_grants where tutor_id=$1 and child_id=$2 and active`, [rose.uid, BRIELLE]))[0]?.can_write
  const { data: rRose } = await rec(rose.client, BRIELLE, P(BRIELLE), 'image/png', 500000)
  ;(roseWrite ? (rRose?.ok) : (rRose?.error === 'not_authorized'))
    ? ok(`granted tutor upload respects can_write (=${roseWrite}), role DERIVED=tutor`) : bad(`tutor: ${JSON.stringify(rRose)}`)
  const { data: rObs } = await rec(obs.client, BRIELLE, P(BRIELLE), 'image/jpeg', 500000)
  rObs?.error === 'not_authorized' ? ok('view-only tutor CANNOT upload (not_authorized)') : bad(`observer: ${JSON.stringify(rObs)}`)
  const brielleLogin = await signInAs(cfg, A.children.brielle.email)  // a child actor
  const { data: rChild } = await rec(brielleLogin.client, BRIELLE, P(BRIELLE), 'image/jpeg', 500000)
  rChild?.error === 'not_authorized' ? ok('a child login CANNOT upload (adults-only in Phase 4)') : bad(`child: ${JSON.stringify(rChild)}`)

  // ================= CROSS-FAMILY ISOLATION =================
  const { data: xRec } = await rec(dana.client, BRIELLE, P(BRIELLE))
  xRec?.error === 'not_authorized' ? ok('ISO: other-family parent cannot upload to my child (not_authorized)') : bad(`cross-record: ${JSON.stringify(xRec)}`)
  const { data: xSeen } = await dana.client.from('uploads').select('id').eq('child_id', BRIELLE)
  ;(xSeen?.length ?? 0) === 0 ? ok('ISO: other-family parent cannot read my child’s inbox (RLS)') : bad('cross-family inbox leak')

  // ---- status lifecycle (owner only); raw work stays immutable ----
  const { data: s1 } = await seth.client.rpc('set_upload_status', { p_upload_id: r1.upload_id, p_status: 'graded' })
  const graded = (await q(`select status, graded_at is not null g from public.uploads where id=$1`, [r1.upload_id]))[0]
  s1?.ok && graded.status === 'graded' && graded.g ? ok('owner moves inbox→graded (graded_at stamped)') : bad(`status: ${JSON.stringify(s1)} ${JSON.stringify(graded)}`)
  const { data: xStatus } = await dana.client.rpc('set_upload_status', { p_upload_id: r1.upload_id, p_status: 'filed' })
  xStatus?.error === 'not_found' ? ok('ISO: other-family parent cannot change my upload’s status (not_found)') : bad(`cross-status: ${JSON.stringify(xStatus)}`)

  // ---- no client direct writes (RLS: writes via RPC only) ----
  const { error: insErr } = await seth.client.from('uploads').insert({ child_id: BRIELLE, uploaded_by: seth.uid, uploader_role: 'parent', storage_path: P(BRIELLE), content_type: 'image/jpeg', byte_size: 1 })
  insErr ? ok('direct client INSERT into uploads is blocked (RPC-only write path)') : bad('client insert leaked')
  const { data: updRows } = await seth.client.from('uploads').update({ status: 'filed' }).eq('id', r1.upload_id).select()
  ;(updRows?.length ?? 0) === 0 ? ok('direct client UPDATE of uploads is blocked (raw work immutable)') : bad('client update leaked')

  // ---- storage bucket: private + limits + no permissive object policy ----
  const bkt = (await q(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='uploads'`))[0]
  bkt && bkt.public === false && Number(bkt.file_size_limit) === 10485760 && bkt.allowed_mime_types.join(',') === 'image/jpeg,image/png,image/heic'
    ? ok('private bucket: public=false, 10MB limit, image mime allowlist') : bad(`bucket: ${JSON.stringify(bkt)}`)
  const objPol = (await q(`select count(*)::int n from pg_policies where schemaname='storage' and tablename='objects' and qual ilike '%uploads%'`))[0].n
  objPol === 0 ? ok('no permissive storage.objects policy for the bucket (server-mediated signed URLs only)') : bad(`storage policies referencing uploads: ${objPol}`)
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-29 UPLOADS: ${fails} FAIL ===` : '\n=== RM-29 UPLOADS: ALL PASS (private bucket; child-scoped inbox; RPC-only writes; cross-family isolation) ===')
process.exit(fails ? 1 : 0)
