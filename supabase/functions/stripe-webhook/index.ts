// stripe-webhook — the ONLY door for verifiable parental consent. verify_jwt=false:
// Stripe sends no Supabase JWT; the HMAC SIGNATURE is the authentication. Verifies
// Stripe-Signature against STRIPE_WEBHOOK_SECRET (env only) with a timestamp
// tolerance; unsigned/forged/stale → 400 with ZERO side effects. On a verified
// checkout.session.completed it creates the no-email child + the immutable consent
// grant ATOMICALLY (grant_consent) + idempotently. NO card data is ever received,
// stored, or logged — only Stripe reference ids.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WH_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
const TOLERANCE = 300 // seconds — reject stale/replayed timestamps

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

// Stripe scheme: Stripe-Signature: t=<ts>,v1=<hex hmac-sha256(secret, `${t}.${body}`)>
async function verify(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  if (!sigHeader || !secret) return false
  const parts: Record<string, string> = {}
  for (const kv of sigHeader.split(',')) { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim() }
  const t = Number(parts.t); const v1 = parts.v1
  if (!t || !v1) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > TOLERANCE) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)))
  // constant-time compare
  if (expected.length !== v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 })
  const sig = req.headers.get('Stripe-Signature') ?? ''
  const payload = await req.text() // RAW body — required for signature verification
  if (!(await verify(payload, sig, WH_SECRET))) return new Response('bad_signature', { status: 400 })

  let event: { id?: string; type?: string; data?: { object?: { metadata?: Record<string, string>; payment_intent?: string; id?: string } } }
  try { event = JSON.parse(payload) } catch { return new Response('bad_json', { status: 400 }) }
  if (!event?.id) return new Response('bad_event', { status: 400 })
  // Refund/dispute events must NEVER mutate consent/child state (MUST-FIX #6).
  // Consent is anchored by the ORIGINAL card transaction; a later refund/dispute
  // does not revoke it and never deletes anything — that is the parent's explicit
  // deletion path only. Acked explicitly (verified event, zero side effects).
  if (event.type?.startsWith('charge.refund') || event.type?.startsWith('charge.dispute')) {
    return new Response('ignored_refund_dispute_no_mutation', { status: 200 })
  }
  // ack any other non-target verified event without side effects (no retry storm)
  if (event.type !== 'checkout.session.completed') return new Response('ignored', { status: 200 })

  const sess = event.data?.object ?? {}
  const md = sess.metadata ?? {}
  const parentUid = md.parent_uid, pendingToken = md.pending_token
  const policyVersion = md.policy_version ?? 'v1'
  const paymentRef = sess.payment_intent ?? sess.id ?? null
  // The nickname/grade are NOT in Stripe metadata (A0) — grant_consent resolves
  // them from the opaque pending token server-side.
  if (!parentUid || !pendingToken) return new Response('ok', { status: 200 }) // nothing actionable; ack

  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  // idempotency pre-check → avoid a needless createUser on replay
  const { data: seen } = await service.from('stripe_events').select('event_id').eq('event_id', event.id).maybeSingle()
  if (seen) return new Response('already_processed', { status: 200 })

  const handle = `c_${crypto.randomUUID()}@child.invalid`
  const secret = crypto.randomUUID() + crypto.randomUUID()
  const { data: created, error: cErr } = await service.auth.admin.createUser({ email: handle, password: secret, email_confirm: true })
  if (cErr || !created?.user) return new Response('create_failed', { status: 500 })

  const { data: g } = await service.rpc('grant_consent', {
    p_parent_id: parentUid, p_auth_user_id: created.user.id, p_pending_token: pendingToken,
    p_method: 'stripe_card_transaction', p_payment_ref: paymentRef, p_policy_version: policyVersion, p_event_id: event.id,
  })
  if (!g?.ok) { await service.auth.admin.deleteUser(created.user.id); return new Response(JSON.stringify(g ?? { error: 'grant_failed' }), { status: 400, headers: { 'Content-Type': 'application/json' } }) }
  if (g.idempotent) await service.auth.admin.deleteUser(created.user.id) // lost the race → drop our orphan user
  return new Response(JSON.stringify({ ok: true, child_id: g.child_id }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
