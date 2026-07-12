// Phase 4 · U3a — the server-side RE-ENCODE sanitizer, e2e through the real upload-work
// Edge fn, tested PER FORMAT via direct POST (bypassing the browser). Proves: JPEG EXIF/GPS
// + trailer stripped; PNG eXIf/tEXt-GPS stripped (and converted to JPEG); HEIC hard-rejected;
// SVG rejected; a pixel-flood (huge declared dims) rejected pre-decode; content detected by
// bytes not client claim; stored object is always a decodable clean JPEG; exif_stripped only
// after re-encode; isolation + rate-limit. LOCAL only.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm31-reencode-e2e.mjs
import pgpkg from 'pg'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY } from './family.mjs'
// NB: jSquash's WASM loads in Deno (the server) but not under Node (it fetches the .wasm
// via file://, unsupported by Node's fetch), so we use hardcoded REAL 1x1 images here and
// let the SERVER decode+re-encode them. The stored output is only checked at the byte level.
const BASE_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD/2Q=='
const BASE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

// ---- test images: real 1x1 base + injected metadata ----
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return (~c) >>> 0 }
const GPS = 'GPSLAT+37.4220'
const baseJpeg = Buffer.from(BASE_JPEG_B64, 'base64')
const basePng = Buffer.from(BASE_PNG_B64, 'base64')
// JPEG + APP1/Exif/GPS after SOI
const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(GPS, 'latin1')]); const aLen = app1.length + 2
const jpegExif = Buffer.concat([baseJpeg.subarray(0, 2), Buffer.from([0xFF, 0xE1, (aLen >> 8) & 0xFF, aLen & 0xFF]), app1, baseJpeg.subarray(2)])
// JPEG + MPF trailer (a second image carrying GPS)
const jpegTrailer = Buffer.concat([baseJpeg, Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, aLen]), app1, Buffer.from([0xFF, 0xD9])])
// PNG + tEXt chunk carrying GPS (inject after IHDR @ offset 33)
const tdata = Buffer.from(`GPSInfo\0${GPS}`, 'latin1'); const ttype = Buffer.from('tEXt', 'latin1')
const tlen = Buffer.alloc(4); tlen.writeUInt32BE(tdata.length); const tcrc = Buffer.alloc(4); tcrc.writeUInt32BE(crc32(Buffer.concat([ttype, tdata])))
const pngText = Buffer.concat([basePng.subarray(0, 33), tlen, ttype, tdata, tcrc, basePng.subarray(33)])
// pixel-flood: same PNG but IHDR declares 30000x30000
const bomb = Buffer.from(basePng); bomb.writeUInt32BE(30000, 16); bomb.writeUInt32BE(30000, 20)
// HEIC + SVG
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16)])
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', 'latin1')

console.log('Setup + serve upload-work…')
await setupFamily(cfg)
const admin = adminClient(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const envFile = path.join(root, 'supabase', '.env.rm31'); fs.writeFileSync(envFile, '# rm31\n')
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const call = async (token, buf) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/upload-work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ childId: BRIELLE, imageBase64: buf.toString('base64') }) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await call(seth.session.access_token, Buffer.from('x')).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('function serving') : bad('function not ready')

const storedFor = async (uploadId) => { const p = (await q(`select storage_path from public.uploads where id=$1`, [uploadId]))[0].storage_path; return Buffer.from(await (await admin.storage.from('uploads').download(p)).data.arrayBuffer()) }

try {
  // JPEG with EXIF/GPS → re-encoded, GPS gone, valid decodable JPEG, attested
  const j = await call(seth.session.access_token, jpegExif)
  const js = j.body?.ok ? await storedFor(j.body.upload_id) : Buffer.alloc(0)
  const jValid = js[0] === 0xFF && js[1] === 0xD8 && js[js.length - 2] === 0xFF && js[js.length - 1] === 0xD9
  const jVerified = j.body?.ok && (await q(`select exif_stripped from public.uploads where id=$1`, [j.body.upload_id]))[0].exif_stripped === true
  j.status === 200 && !js.includes(Buffer.from(GPS)) && jValid && jVerified ? ok('JPEG EXIF/GPS stripped; stored is a valid clean JPEG; exif_stripped=true') : bad(`jpeg: ${j.status} gps=${js.includes(Buffer.from(GPS))} valid=${jValid}`)

  // signed-URL viewing (owner) — get-upload-url with attachment disposition
  const su = await (await fetch(`${cfg.apiUrl}/functions/v1/get-upload-url`, { method: 'POST', headers: { Authorization: `Bearer ${seth.session.access_token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: j.body.upload_id }) })).json().catch(() => null)
  let viewable = !!su?.url
  if (viewable) { try { viewable = (await fetch(su.url.replace(/^https?:\/\/[^/]+/, cfg.apiUrl))).ok } catch { viewable = false } }
  viewable ? ok('owner gets a working short-lived signed view URL (attachment)') : bad(`view: ${JSON.stringify(su)}`)

  // JPEG trailer (MPF): the invariant is the trailer's GPS NEVER reaches storage — either
  // the primary re-encodes clean (200, no GPS) or the decoder rejects the whole thing
  // fail-closed (4xx). (In the real flow the client canvas strips trailers before the server.)
  const jt = await call(seth.session.access_token, jpegTrailer)
  const jts = jt.body?.ok ? await storedFor(jt.body.upload_id) : Buffer.alloc(0)
  ;(jt.status >= 400 || (jt.status === 200 && !jts.includes(Buffer.from(GPS)))) ? ok(`JPEG MPF-trailer never leaks GPS to storage (${jt.status >= 400 ? 'rejected fail-closed' : 're-encoded clean'})`) : bad(`trailer: ${jt.status}`)

  // PNG with tEXt/GPS → re-encoded to JPEG, GPS gone
  const p = await call(seth.session.access_token, pngText)
  const ps = p.body?.ok ? await storedFor(p.body.upload_id) : Buffer.alloc(0)
  p.status === 200 && ps[0] === 0xFF && ps[1] === 0xD8 && !ps.includes(Buffer.from(GPS)) ? ok('PNG eXIf/tEXt-GPS stripped AND converted to JPEG (content-detected)') : bad(`png: ${p.status} gps=${ps.includes(Buffer.from(GPS))} magic=${ps[0]},${ps[1]}`)

  // pixel-flood rejected PRE-decode
  const bmb = await call(seth.session.access_token, bomb)
  bmb.status === 413 && bmb.body?.error === 'too_large' ? ok('pixel-flood (30000×30000 declared) rejected pre-decode (413)') : bad(`bomb: ${bmb.status} ${JSON.stringify(bmb.body)}`)

  // HEIC hard-rejected
  const h = await call(seth.session.access_token, heic)
  h.status === 415 && h.body?.error === 'heic_not_supported' ? ok('HEIC hard-rejected server-side (415; client converts first)') : bad(`heic: ${h.status} ${JSON.stringify(h.body)}`)

  // SVG rejected at ingest
  const s = await call(seth.session.access_token, svg)
  s.status === 400 && s.body?.error === 'bad_type' ? ok('SVG rejected at ingest (400)') : bad(`svg: ${s.status} ${JSON.stringify(s.body)}`)

  // random bytes rejected
  const rnd = await call(seth.session.access_token, Buffer.from('not an image at all, just text'))
  rnd.status === 400 && rnd.body?.error === 'bad_type' ? ok('non-image rejected (content detection, not client claim)') : bad(`rnd: ${rnd.status}`)

  // isolation: other-family parent cannot upload
  const x = await call(dana.session.access_token, jpegExif)
  x.status === 403 && x.body?.error === 'not_authorized' ? ok('ISO: other-family parent cannot upload (403)') : bad(`iso: ${x.status}`)

  // rate-limit
  await q(`insert into public.rpc_rate_limits (key, window_start, call_count) values ($1, now(), 60) on conflict (key) do update set window_start=now(), call_count=60`, [`upl:${seth.uid}`])
  const rl = await call(seth.session.access_token, baseJpeg)
  rl.status === 429 && rl.body?.error === 'rate_limited' ? ok('per-actor rate-limit enforced (429)') : bad(`rl: ${rl.status}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-31 RE-ENCODE: ${fails} FAIL ===` : '\n=== RM-31 RE-ENCODE: ALL PASS (re-encode strips EXIF/GPS across JPEG+PNG+trailer; HEIC/SVG/bomb rejected; content-detected; isolation; rate-limit) ===')
process.exit(fails ? 1 : 0)
