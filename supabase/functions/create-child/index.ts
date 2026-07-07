// create-child — parent-authorized. Creates a NO-EMAIL child identity (opaque
// non-deliverable handle + a random, undisclosed credential → never self-
// loginable) and binds it under the caller via register_child. The SERVICE ROLE
// is used ONLY here and in start-child-session, and ONLY after re-verifying from
// the caller's JWT that the caller is an adult. On any failure the created
// GoTrue user is deleted so no orphan remains.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)
  const body = await req.json().catch(() => ({}))
  const nickname = String(body?.nickname ?? '').slice(0, 40).trim()
  const gradeBand = body?.gradeBand ? String(body.gradeBand).slice(0, 8) : null
  if (!nickname) return json({ error: 'bad_request' }, 400)

  // 1. verify the caller is an authenticated ADULT (a child can't create children)
  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: who } = await caller.auth.getUser()
  if (!who?.user) return json({ error: 'unauthenticated' }, 401)
  const { data: amChild } = await caller.rpc('is_child_actor', { p_uid: who.user.id })
  if (amChild === true) return json({ denied: true, reason: 'not_authorized' }, 403)

  // 2. create the no-email child identity (service role) with an undisclosed secret
  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const handle = `c_${crypto.randomUUID()}@child.invalid`
  const secret = crypto.randomUUID() + crypto.randomUUID()
  const { data: created, error: cErr } = await service.auth.admin.createUser({ email: handle, password: secret, email_confirm: true })
  if (cErr || !created?.user) return json({ error: 'create_failed' }, 500)

  // 3. bind under the caller — SERVICE-ONLY register_child, parent_id derived
  //    from the JWT-verified caller (never client-chosen); it also asserts the
  //    child identity is a fresh @child.invalid handle, so no adult uid can be bound.
  const { data: reg } = await service.rpc('register_child', { p_parent_id: who.user.id, p_auth_user_id: created.user.id, p_nickname: nickname, p_grade_band: gradeBand })
  if (!reg?.ok) {
    await service.auth.admin.deleteUser(created.user.id) // no orphan
    return json({ denied: true, reason: reg?.error ?? 'register_failed' }, 403)
  }
  return json({ child_id: reg.child_id, nickname })
})
