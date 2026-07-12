// Phase 4 · U2 — the upload-work Edge fn (trusted authority) + get-upload-url, e2e
// through the REAL functions. Proves: server-side EXIF scrub (a crafted Exif/GPS
// segment is GONE from the stored object), exif_stripped attested true, signed-URL
// viewing, per-actor rate-limit, and cross-family isolation. LOCAL only.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm30-upload-fn-e2e.mjs
import pgpkg from 'pg'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

// a minimal JPEG whose ONLY payload is an APP1/Exif segment carrying a recognizable
// GPS marker — the server scrub must remove it, leaving just SOI+EOI.
const SECRET = 'GPSGEOTAG_SECRET'
const app1data = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(SECRET, 'latin1')])
const segLen = app1data.length + 2
const jpegWithExif = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xE1, (segLen >> 8) & 0xFF, segLen & 0xFF]), app1data, Buffer.from([0xFF, 0xD9])])
const EXIF_B64 = jpegWithExif.toString('base64')

console.log('Setup + serve upload-work/get-upload-url…')
await setupFamily(cfg)
const admin = adminClient(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const envFile = path.join(root, 'supabase', '.env.rm30'); fs.writeFileSync(envFile, '# rm30\n')
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const call = async (token, fn, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await call(seth.session.access_token, 'upload-work', {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('functions not ready')

try {
  // ---- upload: server-side EXIF scrub + attest ----
  const u = await call(seth.session.access_token, 'upload-work', { childId: BRIELLE, imageBase64: EXIF_B64, note: 'page 1' })
  u.status === 200 && u.body?.ok && u.body.upload_id ? ok('parent uploads work (upload-work 200)') : bad(`upload: ${u.status} ${JSON.stringify(u.body)}`)
  const row = (await q(`select storage_path, exif_stripped, status, byte_size, note from public.uploads where id=$1`, [u.body.upload_id]))[0]
  row?.exif_stripped === true && row.status === 'inbox' && row.note === 'page 1'
    ? ok('row: exif_stripped=TRUE (server attested), status=inbox, note stored') : bad(`row: ${JSON.stringify(row)}`)
  // download the STORED object and prove the EXIF/GPS is gone
  const dl = await admin.storage.from('uploads').download(row.storage_path)
  const stored = Buffer.from(await dl.data.arrayBuffer())
  const hasSecret = stored.includes(Buffer.from(SECRET)) || stored.includes(Buffer.from('Exif'))
  const validJpeg = stored[0] === 0xFF && stored[1] === 0xD8 && stored[stored.length - 2] === 0xFF && stored[stored.length - 1] === 0xD9
  !hasSecret && validJpeg ? ok(`stored object is a clean JPEG with NO Exif/GPS (${stored.length} bytes)`) : bad(`stored still has metadata? secret=${hasSecret} valid=${validJpeg} len=${stored.length}`)

  // ---- HIGH-1 regression: a JPEG TRAILER (MPF/motion-photo) must be DROPPED ----
  // primary image (SOI + SOS + tiny scan + EOI) then a trailer JPEG carrying GPS Exif.
  const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00])
  const primary = Buffer.concat([Buffer.from([0xFF, 0xD8]), sos, Buffer.from([0x12, 0x34]), Buffer.from([0xFF, 0xD9])])
  const TRAILER_GPS = 'GPSLAT+37.4220'
  const tApp1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(TRAILER_GPS, 'latin1')])
  const tLen = tApp1.length + 2
  const trailer = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, (tLen >> 8) & 0xFF, tLen & 0xFF]), tApp1, Buffer.from([0xFF, 0xD9])])
  const mpf = Buffer.concat([primary, trailer])
  const um = await call(seth.session.access_token, 'upload-work', { childId: BRIELLE, imageBase64: mpf.toString('base64') })
  const mrow = um.body?.ok ? (await q(`select storage_path from public.uploads where id=$1`, [um.body.upload_id]))[0] : null
  const mstored = mrow ? Buffer.from(await (await admin.storage.from('uploads').download(mrow.storage_path)).data.arrayBuffer()) : Buffer.alloc(0)
  um.status === 200 && !mstored.includes(Buffer.from(TRAILER_GPS)) && !mstored.includes(Buffer.from('Exif'))
    ? ok('trailer/MPF second-image Exif+GPS is DROPPED (stopped at first EOI, no false attest)') : bad(`trailer survived: ${mstored.includes(Buffer.from(TRAILER_GPS))} len=${mstored.length}`)

  // smuggle attempt: a mid-stream (bogus) SOI carrying an Exif-shaped blob must be REJECTED
  const smuggle = Buffer.concat([Buffer.from([0xFF, 0xD8]), sos, Buffer.from([0x12]), Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x0C]), Buffer.from('SMUGGLE_GPS', 'latin1'), Buffer.from([0xFF, 0xD9])])
  const usm = await call(seth.session.access_token, 'upload-work', { childId: BRIELLE, imageBase64: smuggle.toString('base64') })
  usm.status === 400 && usm.body?.error === 'bad_image' ? ok('mid-stream SOI smuggle attempt rejected (fail-closed, allowlist)') : bad(`smuggle: ${usm.status} ${JSON.stringify(usm.body)}`)

  // ---- signed-URL viewing (owner) ----
  // NOTE: locally the Edge fn's SUPABASE_URL is the internal docker host (kong:8000),
  // so the signed URL's origin isn't host-reachable — rewrite it to the host endpoint
  // for the fetch (the object path + signature token are what matter). On DEV/prod the
  // origin is the public URL and no rewrite is needed.
  const su = await call(seth.session.access_token, 'get-upload-url', { uploadId: u.body.upload_id })
  let viewable = su.status === 200 && !!su.body?.url
  if (viewable) {
    const fixed = su.body.url.replace(/^https?:\/\/[^/]+/, cfg.apiUrl)
    try { viewable = (await fetch(fixed)).ok } catch { viewable = false }
  }
  viewable ? ok('owner gets a working short-lived signed view URL') : bad(`view: ${su.status} ${JSON.stringify(su.body)}`)

  // ---- validation (fail-closed) ----
  const bt = await call(seth.session.access_token, 'upload-work', { childId: BRIELLE, imageBase64: Buffer.from('not-an-image').toString('base64') })
  bt.status === 400 && bt.body?.error === 'bad_type' ? ok('non-JPEG rejected (bad_type)') : bad(`bad_type: ${bt.status} ${JSON.stringify(bt.body)}`)
  const bimg = await call(seth.session.access_token, 'upload-work', { childId: BRIELLE, imageBase64: Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0xFF, 0x41]).toString('base64') })
  bimg.status === 400 && bimg.body?.error === 'bad_image' ? ok('malformed JPEG rejected by the scrub (bad_image, fail-closed)') : bad(`bad_image: ${bimg.status} ${JSON.stringify(bimg.body)}`)

  // ---- CROSS-FAMILY ISOLATION ----
  const xu = await call(dana.session.access_token, 'upload-work', { childId: BRIELLE, imageBase64: EXIF_B64 })
  xu.status === 403 && xu.body?.error === 'not_authorized' ? ok('ISO: other-family parent cannot upload to my child (403)') : bad(`cross-upload: ${xu.status} ${JSON.stringify(xu.body)}`)
  const xv = await call(dana.session.access_token, 'get-upload-url', { uploadId: u.body.upload_id })
  xv.status === 404 ? ok('ISO: other-family parent cannot get a view URL for my upload (404, RLS)') : bad(`cross-view: ${xv.status} ${JSON.stringify(xv.body)}`)

  // ---- rate-limit enforced by the Edge fn ----
  await q(`insert into public.rpc_rate_limits (key, window_start, call_count) values ($1, now(), 60)
           on conflict (key) do update set window_start=now(), call_count=60`, [`upl:${seth.uid}`])
  const rlHit = await call(seth.session.access_token, 'upload-work', { childId: BRIELLE, imageBase64: EXIF_B64 })
  rlHit.status === 429 && rlHit.body?.error === 'rate_limited' ? ok('per-actor rate-limit enforced (429 at the cap)') : bad(`rate-limit: ${rlHit.status} ${JSON.stringify(rlHit.body)}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-30 UPLOAD-FN: ${fails} FAIL ===` : '\n=== RM-30 UPLOAD-FN: ALL PASS (server EXIF scrub; attested; signed-URL view; rate-limit; isolation) ===')
process.exit(fails ? 1 : 0)
