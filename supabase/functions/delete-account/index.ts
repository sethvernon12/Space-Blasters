// delete-account — parent deletes their ENTIRE account (Slice B3). The ONE deletion
// path: it routes every child through the SAME purge_child kernel (via purge_account),
// then removes the parent's operational rows + tombstones their authored messages,
// writes an immutable hash-chained account receipt, and deletes the child GoTrue
// users AND the parent's own GoTrue user. Same edge gate as delete-child: non-child
// actor + FRESH step-up re-auth + rate limit BEFORE any destruction, parent_uid from
// the JWT only. Evidence (consent_ledger/audit_log) is RETAINED under retention.
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
const STEPUP_MAX_AGE = 300 // seconds — fresh re-auth required (5 min)

function authTimeFromJwt(jwt: string): number | null {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    const amr = Array.isArray(payload?.amr) ? payload.amr : []
    const stamps = amr.map((e: { timestamp?: number }) => Number(e?.timestamp)).filter((n: number) => Number.isFinite(n))
    return stamps.length ? Math.max(...stamps) : null
  } catch { return null }
}
async function delUserWithRetry(service: ReturnType<typeof createClient>, id: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) { const { error } = await service.auth.admin.deleteUser(id); if (!error) return true }
  return false
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)
  const jwt = auth.replace(/^Bearer\s+/i, '')

  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: who } = await caller.auth.getUser()
  if (!who?.user) return json({ error: 'unauthenticated' }, 401)
  const parentUid = who.user.id

  // STEP-UP: fresh re-auth (fail-closed if unknown)
  const at = authTimeFromJwt(jwt)
  if (at === null || (Math.floor(Date.now() / 1000) - at) > STEPUP_MAX_AGE) return json({ error: 'reauth_required' }, 401)

  // a child actor can never delete an account
  const { data: amChild } = await caller.rpc('is_child_actor', { p_uid: parentUid })
  if (amChild === true) return json({ denied: true, reason: 'not_authorized' }, 403)

  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })

  // rate-limit (shared ledger with delete-child)
  const { data: rl } = await service.rpc('record_deletion_attempt', { p_parent_id: parentUid })
  if (!rl?.ok) return json({ error: 'rate_limited' }, 429)

  // atomic account purge — every child through the SAME kernel + parent rows
  const { data: p } = await service.rpc('purge_account', { p_parent_id: parentUid, p_deleting_actor: parentUid })
  if (!p?.ok) {
    if (p?.error === 'legal_hold') return json({ error: 'legal_hold' }, 423) // a child under hold blocks it
    return json({ error: 'purge_failed', reason: p?.error }, 500)
  }

  // delete the child GoTrue users, then the parent's own — reconcile drains stragglers
  let status = p.status
  if (!p.idempotent) {
    let allGone = true
    for (const cid of (p.child_auth_user_ids ?? [])) if (!(await delUserWithRetry(service, cid))) allGone = false
    const parentGone = p.parent_auth_user_id ? await delUserWithRetry(service, p.parent_auth_user_id) : true
    if (allGone && parentGone) { await service.rpc('complete_account_deletion', { p_parent_auth_user_id: parentUid }); status = 'completed' }
  } else {
    for (const cid of (p.child_auth_user_ids ?? [])) { try { await service.auth.admin.deleteUser(cid) } catch { /* gone */ } }
    if (p.parent_auth_user_id) { try { await service.auth.admin.deleteUser(p.parent_auth_user_id) } catch { /* gone */ } }
    await service.rpc('complete_account_deletion', { p_parent_auth_user_id: parentUid })
  }

  // off-DB anchor + parent email (fail-closed mock; best-effort)
  try {
    const exp = await exportReceipt({ receipt_id: p.account_receipt_id, receipt_hash: p.receipt_hash, kind: 'account', status })
    if (exp.ok) await service.rpc('mark_receipt_exported', { p_receipt_id: p.account_receipt_id, p_sink: exp.sink })
    await emailReceipt(parentUid, { receipt_id: p.account_receipt_id, receipt_hash: p.receipt_hash, kind: 'account', status })
  } catch { /* best-effort */ }

  return json({
    ok: true, status, account_receipt_id: p.account_receipt_id, receipt_hash: p.receipt_hash,
    children_purged: p.children_purged, idempotent: p.idempotent ?? false,
  })
})
