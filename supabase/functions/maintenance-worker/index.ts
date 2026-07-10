// maintenance-worker — the scheduled system worker that DRIVES the deletion
// mechanisms (B2). Not user-facing: verify_jwt=false, authenticated by a SHARED
// SECRET header (fail-closed — no secret configured ⇒ reject everything), the same
// signature-as-auth doctrine as stripe-webhook. Intended to be invoked by pg_cron
// (via pg_net) or a platform scheduler with X-Maintenance-Secret set.
//
// Each pass (all best-effort, isolated so one failure doesn't abort the rest):
//   1. EXTERNAL PURGE drain — claim queued (child, kind) rows → Storage/AI purge
//      (mock today) → mark done/failed (retried next pass).
//   2. CHILD + ACCOUNT GoTrue reconcile — delete straggler users for receipts left
//      pending_auth_cleanup → complete.
//   3. ORPHAN sweep — delete @child.invalid users older than a grace window with no
//      children row (e.g. a webhook that crashed after createUser).
//   4. pending_children TTL cleanup.
//   5. RETENTION — expire_retained_evidence, ONLY when body.retention===true
//      (destructive; gated behind the LEG-05 attorney numbers, off by default).
//   6. DORMANT — list_dormant_families(cutoff): REPORT only (count). Auto-purge of
//      dormant families is a deliberate later step, never automatic here.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { purgeAiProvider, purgeStorage } from '../_shared/purge-external.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SECRET = Deno.env.get('MAINTENANCE_SECRET') ?? ''
const ORPHAN_GRACE_MS = 60 * 60 * 1000 // 1h — never sweep an in-flight just-created child user

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

// Delete a GoTrue user, returning true ONLY if it is actually gone (deleted now, or
// already absent). A transient error (network/5xx, user still present) returns false
// so the caller leaves the receipt pending_auth_cleanup for the next pass — never
// flip a receipt to 'completed' while a loginable identity still exists (MEDIUM-3).
async function ensureUserGone(service: ReturnType<typeof createClient>, id: string): Promise<boolean> {
  const { error } = await service.auth.admin.deleteUser(id)
  if (!error) return true
  const { data } = await service.auth.admin.getUserById(id)
  return !data?.user
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 })
  // shared-secret auth, fail-closed + constant-ish time compare
  const given = req.headers.get('X-Maintenance-Secret') ?? ''
  if (!SECRET || given.length !== SECRET.length) return json({ error: 'unauthorized' }, 401)
  let diff = 0
  for (let i = 0; i < SECRET.length; i++) diff |= given.charCodeAt(i) ^ SECRET.charCodeAt(i)
  if (diff !== 0) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const out: Record<string, unknown> = {}

  // 1. external purge drain
  try {
    const { data: claimed } = await service.rpc('claim_external_purge', { p_limit: 100 })
    let done = 0, failed = 0
    for (const row of (claimed ?? [])) {
      const res = row.kind === 'storage' ? await purgeStorage(row.child_id) : await purgeAiProvider(row.child_id)
      await service.rpc('complete_external_purge', { p_id: row.id, p_ok: res.ok, p_error: res.ok ? null : res.detail })
      res.ok ? done++ : failed++
    }
    out.external_purge = { done, failed }
  } catch (e) { out.external_purge = { error: String((e as Error).message) } }

  // 2a. child GoTrue reconcile — complete ONLY when the user is confirmed gone
  try {
    const { data: pend } = await service.rpc('list_pending_auth_cleanup')
    let n = 0
    for (const r of (pend ?? [])) {
      if (await ensureUserGone(service, r.child_auth_user_id)) { await service.rpc('complete_child_deletion', { p_child_auth_user_id: r.child_auth_user_id }); n++ }
    }
    out.child_reconcile = n
  } catch (e) { out.child_reconcile = { error: String((e as Error).message) } }

  // 2b. account GoTrue reconcile (children + parent) — complete ONLY if ALL gone
  try {
    const { data: pend } = await service.rpc('list_pending_account_auth_cleanup')
    let n = 0
    for (const r of (pend ?? [])) {
      let allGone = true
      for (const cid of (r.child_auth_user_ids ?? [])) if (!(await ensureUserGone(service, cid))) allGone = false
      const parentGone = r.parent_auth_user_id ? await ensureUserGone(service, r.parent_auth_user_id) : true
      if (allGone && parentGone) { await service.rpc('complete_account_deletion', { p_parent_auth_user_id: r.parent_auth_user_id }); n++ }
      // else: leave pending_auth_cleanup — a straggler parent identity must not be
      // reported completed; retried next pass (MEDIUM-3).
    }
    out.account_reconcile = n
  } catch (e) { out.account_reconcile = { error: String((e as Error).message) } }

  // 3. orphan @child.invalid sweep — FIXED grace window (not caller-tunable: a body
  // knob below the webhook window could sweep an in-flight just-created child).
  // NOTE: scans the first page only (perPage 1000); paginate before large scale.
  try {
    const { data: list } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
    let swept = 0
    for (const u of (list?.users ?? [])) {
      if (!u.email?.endsWith('@child.invalid')) continue
      if (Date.now() - new Date(u.created_at).getTime() < ORPHAN_GRACE_MS) continue
      const { data: kid } = await service.from('children').select('id').eq('auth_user_id', u.id).maybeSingle()
      if (!kid) { try { await service.auth.admin.deleteUser(u.id); swept++ } catch { /* */ } }
    }
    out.orphans_swept = swept
  } catch (e) { out.orphans_swept = { error: String((e as Error).message) } }

  // 4. pending_children TTL
  try { const { data } = await service.rpc('cleanup_pending_children'); out.pending_cleanup = data?.deleted ?? 0 }
  catch (e) { out.pending_cleanup = { error: String((e as Error).message) } }

  // 5. RETENTION — destructive, opt-in only (LEG-05 gate)
  if (body?.retention === true) {
    try { const { data } = await service.rpc('expire_retained_evidence', {}); out.retention = data?.shredded ?? null }
    catch (e) { out.retention = { error: String((e as Error).message) } }
  } else { out.retention = 'skipped (opt-in)' }

  // 6. DORMANT — report only
  try {
    const months = Number(body?.dormant_months ?? 18)
    const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await service.rpc('list_dormant_families', { p_cutoff: cutoff })
    out.dormant = { cutoff, count: (data ?? []).length } // identification only; never auto-purged here
  } catch (e) { out.dormant = { error: String((e as Error).message) } }

  return json({ ok: true, ...out })
})
