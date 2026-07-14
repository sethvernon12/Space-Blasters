// receipt-sink — the off-DB deletion-receipt ANCHOR sink (Phase 5 · Slice 1). A thin
// receiver that persists the OPAQUE receipt anchor to a PRIVATE Storage bucket, one
// IMMUTABLE object per receipt. This is the PITR replay anchor: Storage is a durability
// domain SEPARATE from the Postgres timeline, so the anchor survives a DB shred/restore —
// the anchor's whole job.
//
// STRONG BORDERS (LEG-04): only the four opaque fields {receipt_id, receipt_hash, kind,
// status} are ever accepted or stored — never a child nickname, the disposition, or the
// hash chain. An extra field is REJECTED (defense-in-depth on payload opaqueness).
//
// AUTH: a shared secret, fail-closed (no secret ⇒ reject everything), same doctrine as
// maintenance-worker; verify_jwt=false. IMMUTABILITY: first write wins; a replay of the
// same id with the SAME hash is idempotent; a different hash for the same id is a conflict
// (never silently overwrite an anchor). GET (?receipt_id=) serves the caller's READ-AFTER-
// WRITE confirm — a bare 2xx is a CLAIM; a matching read-back is the CONFIRMATION the
// covenant requires before a receipt may ever become shreddable.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SECRET = Deno.env.get('RECEIPT_SINK_SECRET') ?? ''
const BUCKET = 'receipt-anchor'

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const keyOf = (id: string) => `receipts/${id}.json`

// fail-closed, constant-ish-time shared-secret check via a custom header (same doctrine as
// maintenance-worker's X-Maintenance-Secret — a system header, not user auth)
function authed(req: Request): boolean {
  const given = req.headers.get('X-Receipt-Sink-Secret') ?? ''
  if (!SECRET || given.length !== SECRET.length) return false
  let diff = 0
  for (let i = 0; i < SECRET.length; i++) diff |= given.charCodeAt(i) ^ SECRET.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (!authed(req)) return json({ error: 'unauthorized' }, 401)
  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })

  // READ-BACK — the caller's read-after-write confirm source
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('receipt_id') ?? ''
    if (!UUID_RE.test(id)) return json({ error: 'bad_request' }, 400)
    const { data, error } = await service.storage.from(BUCKET).download(keyOf(id))
    if (error || !data) return json({ error: 'not_found' }, 404)
    let stored: unknown
    try { stored = JSON.parse(await data.text()) } catch { return json({ error: 'corrupt_anchor' }, 500) }
    return json(stored)
  }

  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400)
  // OPAQUENESS: exactly the four anchor fields, nothing else may ever be stored.
  const keys = Object.keys(body).sort()
  const allowed = ['kind', 'receipt_hash', 'receipt_id', 'status']
  if (keys.length !== allowed.length || !keys.every((k, i) => k === allowed[i])) return json({ error: 'unexpected_field' }, 400)
  const { receipt_id, receipt_hash, kind, status } = body as Record<string, unknown>
  if (!UUID_RE.test(String(receipt_id))) return json({ error: 'bad_receipt_id' }, 400)
  if (typeof receipt_hash !== 'string' || receipt_hash.length < 1 || receipt_hash.length > 256) return json({ error: 'bad_hash' }, 400)
  if (kind !== 'child' && kind !== 'account') return json({ error: 'bad_kind' }, 400)
  if (typeof status !== 'string' || status.length > 64) return json({ error: 'bad_status' }, 400)

  const key = keyOf(String(receipt_id))
  const payload = new Blob([JSON.stringify({ receipt_id, receipt_hash, kind, status })], { type: 'application/json' })

  // IMMUTABLE append-only: first write wins (upsert:false). A replay with the same hash
  // is idempotent; a different hash for the same id is refused (never overwrite an anchor).
  const { error: upErr } = await service.storage.from(BUCKET).upload(key, payload, { contentType: 'application/json', upsert: false })
  if (upErr) {
    const { data: existing } = await service.storage.from(BUCKET).download(key)
    if (existing) {
      let prev: { receipt_hash?: unknown }
      try { prev = JSON.parse(await existing.text()) } catch { return json({ error: 'corrupt_anchor' }, 500) }
      if (prev.receipt_hash === receipt_hash) return json({ ok: true, stored: 'idempotent' })
      return json({ error: 'anchor_conflict' }, 409)
    }
    return json({ error: 'store_failed' }, 500)
  }
  return json({ ok: true, stored: 'written' })
})
