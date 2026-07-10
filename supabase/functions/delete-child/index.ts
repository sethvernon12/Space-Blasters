// delete-child — parent-only consent revocation -> hard deletion (Slice A).
// The Edge layer is the GATE (MUST-FIX #4): it proves parent-ownership + non-child
// actor + fresh step-up re-auth + rate limit BEFORE any destructive call, sourcing
// parent_uid ONLY from the JWT-verified caller. It then runs the two-system seam
// (MUST-FIX #2): revoke the child's sessions FIRST -> purge_child (one atomic DB tx
// with the disposition matrix + immutable receipt) -> delete the GoTrue child user
// (retry) -> complete_child_deletion flips the receipt to 'completed'. A straggler
// stays 'pending_auth_cleanup' for the reconciliation drain. Uniform not-found for
// not-yours/not-there. NO card/child PII is logged.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { emailReceipt, exportReceipt } from '../_shared/notify.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const STEPUP_MAX_AGE = 300 // seconds — fresh re-auth required (5 min, LEG precedent)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)

  // 1) authenticate the caller
  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: who } = await caller.auth.getUser()
  if (!who?.user) return json({ error: 'unauthenticated' }, 401)
  const parentUid = who.user.id

  // 2) STEP-UP: require a RECENT actual sign-in. last_sign_in_at advances on every
  //    real sign-in — password OR a Google OAuth re-auth — but NOT on a silent token
  //    refresh, so it's the correct cross-provider "authenticated recently" signal.
  //    (The JWT `amr` timestamp does NOT advance on a Google re-auth, which looped.)
  //    Fail-closed if absent/unparseable.
  const lastSignInMs = who.user.last_sign_in_at ? Date.parse(who.user.last_sign_in_at) : NaN
  if (!Number.isFinite(lastSignInMs) || (Date.now() - lastSignInMs) > STEPUP_MAX_AGE * 1000) {
    return json({ error: 'reauth_required' }, 401)
  }

  // 3) never a child actor
  const { data: amChild } = await caller.rpc('is_child_actor', { p_uid: parentUid })
  if (amChild === true) return json({ denied: true, reason: 'not_authorized' }, 403)

  const body = await req.json().catch(() => ({}))
  const childId = String(body?.childId ?? body?.child_id ?? '')
  if (!childId) return json({ error: 'bad_request' }, 400)

  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })

  // 4) rate-limit FIRST (MUST-FIX #5) — bounds repeated attempts AND denial probes
  //    so audit/attempt tables can't be spammed by guessing child ids.
  const { data: rl } = await service.rpc('record_deletion_attempt', { p_parent_id: parentUid })
  if (!rl?.ok) return json({ error: 'rate_limited' }, 429)

  // 5) OWNERSHIP predicate AT THE EDGE, before any destructive call. parent_uid is
  //    the JWT-verified caller; a non-owned/absent child gets a UNIFORM not_found.
  const { data: kid } = await service.from('children').select('id, auth_user_id').eq('id', childId).eq('parent_id', parentUid).maybeSingle()
  if (!kid) return json({ error: 'not_found' }, 404)
  const childAuthUser: string | null = kid.auth_user_id ?? null

  // 6) revoke the child's sessions FIRST (MUST-FIX #2) — ban invalidates refresh +
  //    blocks re-auth; the imminent user delete + children-row removal (RLS fails
  //    closed) + the suppressions tombstone guard cover the stateless-token window.
  if (childAuthUser) {
    try { await service.auth.admin.updateUserById(childAuthUser, { ban_duration: '876000h' }) } catch { /* best-effort; purge + delete follow */ }
  }

  // 7) atomic DB purge (disposition matrix + immutable receipt)
  const { data: p } = await service.rpc('purge_child', { p_child_id: childId, p_parent_id: parentUid, p_deleting_actor: parentUid })
  if (!p?.ok) {
    if (p?.error === 'legal_hold') return json({ error: 'legal_hold' }, 423)
    if (p?.error === 'not_found' || p?.error === 'not_owner') return json({ error: 'not_found' }, 404)
    return json({ error: 'purge_failed' }, 500)
  }

  // 8) delete the GoTrue child user (retry); reconciliation drains any straggler
  let status = p.status
  if (childAuthUser && !p.idempotent) {
    let deleted = false
    for (let i = 0; i < 3 && !deleted; i++) {
      const { error } = await service.auth.admin.deleteUser(childAuthUser)
      if (!error) deleted = true
    }
    if (deleted) {
      await service.rpc('complete_child_deletion', { p_child_auth_user_id: childAuthUser })
      status = 'completed'
    }
    // else: receipt stays 'pending_auth_cleanup' for list_pending_auth_cleanup drain
  } else if (childAuthUser && p.idempotent) {
    // already-purged replay: ensure the user is gone + receipt finalized
    try { await service.auth.admin.deleteUser(childAuthUser) } catch { /* may already be gone */ }
    await service.rpc('complete_child_deletion', { p_child_auth_user_id: childAuthUser })
  }

  // off-DB anchor + parent email (fail-closed mock; best-effort — a straggler is
  // re-exported by the reconcile drain). Only opaque ids/hash leave the system.
  try {
    const exp = await exportReceipt({ receipt_id: p.receipt_id, receipt_hash: p.receipt_hash, kind: 'child', status })
    // mark exported ONLY on success — a failed export must not let retention shred
    // the receipt (retention additionally requires a non-mock sink).
    if (exp.ok) await service.rpc('mark_receipt_exported', { p_receipt_id: p.receipt_id, p_sink: exp.sink })
    await emailReceipt(parentUid, { receipt_id: p.receipt_id, receipt_hash: p.receipt_hash, kind: 'child', status })
  } catch { /* best-effort */ }

  return json({
    ok: true, status, receipt_id: p.receipt_id, receipt_hash: p.receipt_hash,
    disposition: p.disposition, idempotent: p.idempotent ?? false,
  })
})
