// Phase 4 · U3b — tutor upload + the Inbox→In-Progress→Graded→Filed status lifecycle.
// LOCAL only. A can-write tutor uploads (role derived server-side) and moves status;
// the owner can too; a VIEW-ONLY tutor and another family cannot change status (they may
// still READ). Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm32-status-e2e.mjs
import pgpkg from 'pg'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId
const BASE_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD/2Q=='
// prepend a benign APP1 — this variant decodes reliably as the WASM's first decode (a
// degenerate 1x1 with APP0-immediately can otherwise abort mozjpeg on cold start; a real
// camera photo is never degenerate). Content-detection still routes it as jpeg.
const _b = Buffer.from(BASE_JPEG_B64, 'base64')
const _a = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('x', 'latin1')]); const _al = _a.length + 2
const TEST_JPEG_B64 = Buffer.concat([_b.subarray(0, 2), Buffer.from([0xFF, 0xE1, (_al >> 8) & 0xFF, _al & 0xFF]), _a, _b.subarray(2)]).toString('base64')
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

console.log('Setup + serve upload-work…')
await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const rose = await signInAs(cfg, A.tutor.email)       // can-write tutor for Brielle
const obs = await signInAs(cfg, A.observer.email)     // view-only grant
const dana = await signInAs(cfg, B.parent.email)
const roseWrite = (await q(`select can_write from public.tutor_grants where tutor_id=$1 and child_id=$2 and active`, [rose.uid, BRIELLE]))[0]?.can_write
const envFile = path.join(root, 'supabase', '.env.rm32'); fs.writeFileSync(envFile, '# rm32\n')
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const upload = async (token) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/upload-work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ childId: BRIELLE, imageBase64: TEST_JPEG_B64 }) })
  let b = null; try { b = await r.json() } catch { /* */ }; return { status: r.status, body: b }
}
// ready = a real base-JPEG upload SUCCEEDS (200) — this also warms the mozjpeg WASM
// decoder (its first decode after serve-start can transiently 400 before it loads).
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await upload(seth.session.access_token).catch(() => null); if (r && r.status === 200) ready = true }
ready ? ok('function serving + decoder warm') : bad('function not ready')

try {
  // ---- a can-write tutor uploads; role is DERIVED = tutor ----
  const tu = roseWrite ? await upload(rose.session.access_token) : { status: 0 }
  const uid = tu.body?.upload_id
  const trow = uid ? (await q(`select uploader_role, uploaded_by, status from public.uploads where id=$1`, [uid]))[0] : null
  roseWrite && tu.status === 200 && trow?.uploader_role === 'tutor' && trow.uploaded_by === rose.uid && trow.status === 'inbox'
    ? ok('can-write tutor uploads; uploader_role DERIVED=tutor; status=inbox') : bad(`tutor upload: ${tu.status} ${JSON.stringify(trow)}`)

  // ---- status lifecycle by the tutor: inbox → in_progress → graded → filed ----
  const st = async (client, s) => (await client.rpc('set_upload_status', { p_upload_id: uid, p_status: s })).data
  let r = await st(rose.client, 'in_progress'); const s1 = (await q(`select status from public.uploads where id=$1`, [uid]))[0].status
  r?.ok && s1 === 'in_progress' ? ok('tutor: inbox → in_progress') : bad(`in_progress: ${JSON.stringify(r)} ${s1}`)
  r = await st(rose.client, 'graded'); const g = (await q(`select status, graded_at is not null gg from public.uploads where id=$1`, [uid]))[0]
  r?.ok && g.status === 'graded' && g.gg ? ok('tutor: → graded (graded_at stamped)') : bad(`graded: ${JSON.stringify(g)}`)
  r = await st(rose.client, 'filed'); const s3 = (await q(`select status from public.uploads where id=$1`, [uid]))[0].status
  r?.ok && s3 === 'filed' ? ok('tutor: → filed') : bad(`filed: ${s3}`)

  // ---- the owner (parent) can also transition ----
  const rp = await st(seth.client, 'in_progress')
  rp?.ok && (await q(`select status from public.uploads where id=$1`, [uid]))[0].status === 'in_progress' ? ok('the owning parent can also move status') : bad(`parent status: ${JSON.stringify(rp)}`)

  // ---- view-only tutor: can READ the inbox, CANNOT change status ----
  const { data: obsSees } = await obs.client.from('uploads').select('id').eq('id', uid)
  ;(obsSees?.length ?? 0) === 1 ? ok('view-only tutor can READ the child’s inbox') : bad('view-only tutor cannot see the inbox')
  const ro = await st(obs.client, 'graded')
  ro?.ok === false && ro.error === 'not_found' ? ok('view-only tutor CANNOT change status (not_found)') : bad(`view-only status: ${JSON.stringify(ro)}`)
  // and view-only cannot upload
  const ou = await upload(obs.session.access_token)
  ou.status === 403 ? ok('view-only tutor CANNOT upload (403)') : bad(`view-only upload: ${ou.status}`)

  // ---- cross-family: cannot change status, cannot see ----
  const rd = await st(dana.client, 'inbox')
  rd?.ok === false && rd.error === 'not_found' ? ok('ISO: other-family parent CANNOT change status (not_found)') : bad(`cross status: ${JSON.stringify(rd)}`)
  const { data: danaSees } = await dana.client.from('uploads').select('id').eq('id', uid)
  ;(danaSees?.length ?? 0) === 0 ? ok('ISO: other-family parent cannot see the inbox (RLS)') : bad('cross-family inbox leak')
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-32 STATUS: ${fails} FAIL ===` : '\n=== RM-32 STATUS: ALL PASS (tutor upload role-derived; full status lifecycle; view-only read-only; cross-family blocked) ===')
process.exit(fails ? 1 : 0)
