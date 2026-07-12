// upload-work — Phase 4 · U2. The TRUSTED AUTHORITY for homework-photo uploads. The
// client has already HEIC-decoded + canvas-re-encoded (EXIF stripped) + downscaled;
// this function is the fail-closed SECOND layer and the only thing that may attest the
// strip. In order: authenticate the caller → per-actor rate-limit → re-check ownership
// + consent IN CODE (service key bypasses RLS, HARD RULE #2) → validate JPEG magic +
// size → SERVER-SIDE scrub every APP1-APP15/COM metadata segment (drops Exif/GPS/XMP/
// ICC) → store to the private bucket under a child-namespaced path → record_upload
// (as the user, re-checks ownership) → mark_upload_verified (service) sets
// exif_stripped=true. Any failure removes the stored object. No child PII is logged.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MAX_BYTES = 10 * 1024 * 1024

// Strip every APPn (n>=1) + COM metadata segment from a JPEG — including markers
// BETWEEN progressive scans — and DROP anything after the first true EOI (a trailer:
// MPF / motion-photo second image carries its own Exif/GPS). Keeps SOI, APP0/JFIF,
// tables, frame, and each entropy-coded scan verbatim. Throws on a malformed marker
// stream (fail-closed → the upload is rejected, never stored with a false attestation).
function scrubJpeg(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('not_jpeg')
  const out = new Uint8Array(b.length)
  let o = 0
  out[o++] = 0xFF; out[o++] = 0xD8   // SOI
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xFF) throw new Error('malformed')
    let j = i
    while (j < b.length && b[j] === 0xFF) j++   // consume fill 0xFFs → j = the marker byte
    if (j >= b.length) throw new Error('malformed')
    const m = b[j]
    if (m === 0xD9) { out[o++] = 0xFF; out[o++] = 0xD9; break }   // FIRST EOI → stop; drop any trailer
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { out[o++] = 0xFF; out[o++] = m; i = j + 1; continue } // standalone RSTn/TEM
    if (m === 0xD8) throw new Error('malformed')                 // a mid-stream SOI is not a valid segment (no smuggling)
    if (j + 2 >= b.length) throw new Error('malformed')
    const segLen = (b[j + 1] << 8) | b[j + 2]
    const segEnd = j + 1 + segLen
    if (segLen < 2 || segEnd > b.length) throw new Error('malformed')
    if (m === 0xDA) {                                   // SOS: keep header, then copy scan to the next marker
      out[o++] = 0xFF; out[o++] = 0xDA
      for (let k = j + 1; k < segEnd; k++) out[o++] = b[k]   // SOS header (length + component spec)
      let k = segEnd
      while (k < b.length) {
        if (b[k] === 0xFF) {
          const n = b[k + 1]
          if (n === 0x00 || (n >= 0xD0 && n <= 0xD7)) { out[o++] = b[k]; out[o++] = n; k += 2; continue } // stuffed FF / RSTn = scan data
          break                                         // a real marker → next segment (another scan, tables, or EOI)
        }
        out[o++] = b[k]; k++
      }
      i = k
      continue
    }
    // ALLOWLIST: keep ONLY structural image markers verbatim — frame headers (0xC0-0xCF
    // except 0xC8/JPG) and tables/restart-interval/etc. (0xDB-0xDF). DROP every
    // application + comment marker (all APPn incl APP0, COM) and anything non-structural,
    // so no metadata channel (Exif/XMP/ICC/IPTC/JFIF-padding) can survive.
    const structural = (m >= 0xC0 && m <= 0xCF && m !== 0xC8) || (m >= 0xDB && m <= 0xDF)
    if (structural) { for (let k = j - 1; k < segEnd; k++) out[o++] = b[k] }
    i = segEnd
  }
  return out.subarray(0, o)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)

  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: who } = await caller.auth.getUser()
  if (!who?.user) return json({ error: 'unauthenticated' }, 401)
  const uid = who.user.id
  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })

  const body = await req.json().catch(() => ({}))
  const childId = String(body?.childId ?? '')
  const note = body?.note != null ? String(body.note) : null
  const b64 = String(body?.imageBase64 ?? '')
  if (!childId || !b64) return json({ error: 'bad_request' }, 400)

  // 1) per-actor rate-limit (HARD RULE #8) BEFORE any storage work
  const { data: rl } = await service.rpc('check_upload_rate', { p_actor: uid })
  if (!rl?.ok) return json({ error: 'rate_limited' }, 429)

  // 2) ownership + consent re-check IN CODE (service bypasses RLS, HARD RULE #2)
  const { data: kid } = await service.from('children').select('parent_id, consent_id, auth_user_id').eq('id', childId).maybeSingle()
  if (!kid) return json({ error: 'not_found' }, 404)
  let canWrite = kid.parent_id === uid
  if (!canWrite) {
    const { data: g } = await service.from('tutor_grants').select('can_write').eq('tutor_id', uid).eq('child_id', childId).eq('active', true).maybeSingle()
    canWrite = !!g?.can_write
  }
  if (kid.auth_user_id === uid) canWrite = false           // a child login can never upload
  if (!canWrite) return json({ error: 'not_authorized' }, 403)
  if (!kid.consent_id) return json({ error: 'no_consent' }, 403)   // HARD RULE #1

  // 3) decode + validate + SERVER-SIDE scrub
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) } catch { return json({ error: 'bad_image' }, 400) }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return json({ error: 'bad_size' }, 400)
  if (!(bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF)) return json({ error: 'bad_type' }, 400) // JPEG magic
  let clean: Uint8Array
  try { clean = scrubJpeg(bytes) } catch { return json({ error: 'bad_image' }, 400) }   // fail-closed

  // 4) store the CLEAN bytes under the child namespace
  const path = `${childId}/${crypto.randomUUID()}.jpg`
  const up = await service.storage.from('uploads').upload(path, clean, { contentType: 'image/jpeg', upsert: false })
  if (up.error) return json({ error: 'store_failed' }, 500)

  // 5) record the row (as the user — re-checks ownership/consent), then attest the strip
  const { data: rec } = await caller.rpc('record_upload', {
    p_child_id: childId, p_storage_path: path, p_content_type: 'image/jpeg', p_byte_size: clean.length, p_note: note,
  })
  if (!rec?.ok) {
    await service.storage.from('uploads').remove([path])   // no orphan object on a failed record
    return json({ error: rec?.error ?? 'record_failed' }, 403)
  }
  await service.rpc('mark_upload_verified', { p_upload_id: rec.upload_id })  // exif_stripped=true (server guaranteed)
  return json({ ok: true, upload_id: rec.upload_id, bytes: clean.length })
})
