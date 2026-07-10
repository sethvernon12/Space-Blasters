// create-consent-checkout — parent-authorized. Starts the Stripe Checkout for the
// VPC (nominal, refundable) that anchors consent. The SECURITY-CRITICAL invariant
// (SEC-REV-21): metadata.parent_uid is stamped SERVER-SIDE from the JWT-verified
// caller — NEVER from a client field — so the signature-verified webhook records
// consent under the real payer. Uses only the caller JWT + the Stripe secret key
// (env); NO Supabase service role here. No card data ever touches this function.
//
// DATA MINIMIZATION (A0): the child's nickname/grade are NEVER sent to Stripe.
// They are stashed in a service-only pending_children row (create_pending_child,
// which stamps parent_id = auth.uid()); only the OPAQUE token + the non-PII
// parent_uid ride in Stripe metadata. The webhook resolves the token server-side.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { createConsentCheckout } from '../_shared/stripe.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!

// returnUrl must be an allow-listed hub origin (no open self-redirect). With
// HUB_ALLOWED_ORIGINS set (DEV/staging) only those origins pass; unset (local
// dev) only localhost/127.0.0.1. Fail-closed.
function returnUrlOk(returnUrl: string): boolean {
  let u: URL
  try { u = new URL(returnUrl) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const allowed = (Deno.env.get('HUB_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (allowed.length) return allowed.includes(u.origin)
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)

  // authenticated ADULT only (children never start a checkout) — checked FIRST
  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: who } = await caller.auth.getUser()
  if (!who?.user) return json({ error: 'unauthenticated' }, 401)
  const { data: amChild } = await caller.rpc('is_child_actor', { p_uid: who.user.id })
  if (amChild === true) return json({ denied: true, reason: 'not_authorized' }, 403)

  const body = await req.json().catch(() => ({}))
  const nickname = String(body?.nickname ?? '').slice(0, 40).trim()
  const grade = body?.gradeBand ? String(body.gradeBand).slice(0, 8) : ''
  const returnUrl = String(body?.returnUrl ?? '')
  if (!nickname) return json({ error: 'bad_request' }, 400)
  if (!returnUrlOk(returnUrl)) return json({ error: 'bad_return_url' }, 400)

  // Stash the nickname/grade OUR side (service-only pending row); parent_id is
  // stamped from auth.uid() inside the definer RPC — the caller can't forge it.
  const { data: pend, error: pErr } = await caller.rpc('create_pending_child', { p_nickname: nickname, p_grade_band: grade || null })
  if (pErr || !pend?.ok || !pend?.token) return json({ error: 'pending_failed' }, pend?.error === 'not_authorized' ? 403 : 502)

  // parent_uid is SERVER-DERIVED (SEC-REV-21); the child's nickname/grade are NOT
  // sent to Stripe — only the opaque pending token + the (non-PII) payer uid.
  const metadata: Record<string, string> = { parent_uid: who.user.id, pending_token: pend.token, policy_version: 'v1' }
  const sep = returnUrl.includes('?') ? '&' : '?'
  try {
    const { url, mock } = await createConsentCheckout({
      metadata,
      successUrl: `${returnUrl}${sep}consent=complete`,
      cancelUrl: `${returnUrl}${sep}consent=cancel`,
    })
    // parent_uid echoed back is the SERVER-STAMPED value (the caller's own uid) —
    // lets a client confirm it can't override it (SEC-REV-21). Not sensitive.
    return json({ url, mock, parent_uid: who.user.id })
  } catch {
    return json({ error: 'checkout_failed' }, 502)
  }
})
