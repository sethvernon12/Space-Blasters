// upload-work — Phase 4 · U3a. The TRUSTED AUTHORITY for homework-photo uploads,
// rebuilt around SERVER-SIDE RE-ENCODE (SEC-U3, 2026-07-11): the client is not the
// sanitization boundary. In order: authenticate → per-actor rate-limit → re-check
// ownership + consent IN CODE (service bypasses RLS, HARD RULE #2) → detect the format
// by CONTENT (magic/box), not the client's claim → hard-reject HEIC (client converts
// first) and SVG/unknown → parse dimensions BEFORE decode and enforce a megapixel/dim
// cap (defeats decompression bombs that a byte-size check misses) → DECODE (jSquash
// JPEG/PNG) → downscale → RE-ENCODE a fresh, metadata-free JPEG (drops EXIF/GPS incl.
// the IFD1 thumbnail, PNG eXIf/tEXt/iTXt chunks, trailers, stego, polyglots — all at
// once) → store the clean JPEG under a server-chosen child-namespaced path →
// record_upload (as the user) → mark_upload_verified (service). Failure removes the
// object. No child PII is logged.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { decode as decodeJpeg, encode as encodeJpeg } from 'npm:@jsquash/jpeg@1.6.0'
import { decode as decodePng } from 'npm:@jsquash/png@3.1.1'
import resize from 'npm:@jsquash/resize@2.1.1'

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
const MAX_INPUT_DIM = 8000           // reject any side over this (pre-decode)
const MAX_INPUT_MP = 15_000_000      // reject over 15 megapixels (decompression-bomb guard; edge-fn memory headroom)
const OUTPUT_MAX_DIM = 2600          // downscale output — high enough for faint pencil, bounded
const JPEG_QUALITY = 90

// content-based format detection (NEVER the client's declared type)
function detectFormat(b: Uint8Array): 'jpeg' | 'png' | 'heic' | 'svg' | 'unknown' {
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'png'
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {   // ISOBMFF 'ftyp'
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif'].includes(brand)) return 'heic'
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, Math.min(b.length, 256))).toLowerCase()
  if (head.includes('<svg') || head.includes('<?xml')) return 'svg'
  return 'unknown'
}
// parse dimensions WITHOUT allocating pixels (pre-decode bomb guard)
function jpegDims(b: Uint8Array): { w: number; h: number } | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) return null
    let j = i; while (j < b.length && b[j] === 0xFF) j++
    const m = b[j]
    if (m === 0xD9 || m === 0xDA) return null
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {   // SOFn
      return { h: (b[j + 4] << 8) | b[j + 5], w: (b[j + 6] << 8) | b[j + 7] }
    }
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { i = j + 1; continue }
    const segLen = (b[j + 1] << 8) | b[j + 2]
    if (segLen < 2) return null
    i = j + 1 + segLen
  }
  return null
}
function pngDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24) return null                                              // IHDR: width@16, height@20 (BE)
  return { w: (((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0), h: (((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0) }
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

  // 1) rate-limit BEFORE any decode/storage work
  const { data: rl } = await service.rpc('check_upload_rate', { p_actor: uid })
  if (!rl?.ok) return json({ error: 'rate_limited' }, 429)

  // 2) ownership + consent re-check IN CODE (service bypasses RLS, HARD RULE #2)
  const { data: kid } = await service.from('children').select('parent_id, consent_id, auth_user_id').eq('id', childId).maybeSingle()
  if (!kid) return json({ error: 'not_found' }, 404)
  let canWrite = kid.parent_id === uid
  if (!canWrite) {
    // multiplicity-tolerant (S5a): a tutor may hold >1 active grant for a child (a parent_direct grant
    // plus per-group group_derived grants) — authorize if ANY active grant is writable, mirroring the
    // can_write_child SQL gate (EXISTS active AND can_write). maybeSingle() would 406/PGRST116 on 2+ rows.
    const { data: g } = await service.from('tutor_grants').select('can_write').eq('tutor_id', uid).eq('child_id', childId).eq('active', true)
    canWrite = Array.isArray(g) && g.some((row) => row.can_write)
  }
  if (kid.auth_user_id === uid) canWrite = false
  if (!canWrite) return json({ error: 'not_authorized' }, 403)
  if (!kid.consent_id) return json({ error: 'no_consent' }, 403)

  // 3) decode base64 + content detection + pre-decode cap
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) } catch { return json({ error: 'bad_image' }, 400) }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return json({ error: 'bad_size' }, 400)
  const fmt = detectFormat(bytes)
  if (fmt === 'heic') return json({ error: 'heic_not_supported' }, 415)      // hard-reject; the client converts HEIC first
  if (fmt !== 'jpeg' && fmt !== 'png') return json({ error: 'bad_type' }, 400) // SVG / unknown rejected at ingest
  const dims = fmt === 'jpeg' ? jpegDims(bytes) : pngDims(bytes)
  if (!dims || dims.w <= 0 || dims.h <= 0) return json({ error: 'bad_image' }, 400)
  if (dims.w > MAX_INPUT_DIM || dims.h > MAX_INPUT_DIM || dims.w * dims.h > MAX_INPUT_MP) return json({ error: 'too_large' }, 413)

  // 4) DECODE → downscale → RE-ENCODE a fresh, metadata-free JPEG
  let clean: Uint8Array
  try {
    const src = fmt === 'jpeg' ? await decodeJpeg(bytes.buffer as ArrayBuffer) : await decodePng(bytes.buffer as ArrayBuffer)
    const scale = Math.min(1, OUTPUT_MAX_DIM / Math.max(src.width, src.height))
    const img = scale < 1
      ? await resize(src, { width: Math.max(1, Math.round(src.width * scale)), height: Math.max(1, Math.round(src.height * scale)) })
      : src
    clean = new Uint8Array(await encodeJpeg(img, { quality: JPEG_QUALITY }))
  } catch { return json({ error: 'bad_image' }, 400) }                        // decode/encode failure → fail-closed reject
  if (!(clean[0] === 0xFF && clean[1] === 0xD8)) return json({ error: 'encode_failed' }, 500)

  // 5) store the CLEAN JPEG under the child namespace
  const path = `${childId}/${crypto.randomUUID()}.jpg`
  const upl = await service.storage.from('uploads').upload(path, clean, { contentType: 'image/jpeg', upsert: false })
  if (upl.error) return json({ error: 'store_failed' }, 500)

  // 6) record (as the user; re-checks) then attest the strip. Any failure OR unexpected
  // throw removes the stored object so a private image never orphans without a row.
  try {
    const { data: rec } = await caller.rpc('record_upload', {
      p_child_id: childId, p_storage_path: path, p_content_type: 'image/jpeg', p_byte_size: clean.length, p_note: note,
    })
    if (!rec?.ok) { await service.storage.from('uploads').remove([path]); return json({ error: rec?.error ?? 'record_failed' }, 403) }
    await service.rpc('mark_upload_verified', { p_upload_id: rec.upload_id })
    return json({ ok: true, upload_id: rec.upload_id, bytes: clean.length })
  } catch {
    await service.storage.from('uploads').remove([path]).catch(() => {})
    return json({ error: 'record_failed' }, 500)
  }
})
