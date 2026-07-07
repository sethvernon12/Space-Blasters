// start-child-session — the ONLY door into a child's hub. Re-verifies from the
// caller's JWT that the caller is the child's PARENT (authorize_and_record_mint:
// ownership + rate-limit + audit) BEFORE any service-role use, then mints a
// single-use, short-lived one-time link and exchanges it SERVER-SIDE into the
// child's session. The raw link / token is NEVER returned to any client — only
// the resulting session tokens.
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
  const childId = body?.childId
  if (!childId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(childId)) return json({ error: 'bad_request' }, 400)

  // 1. ownership + rate-limit + audit — keyed to the caller's auth.uid().
  //    A non-parent / over-limit caller gets nothing to mint against.
  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: az } = await caller.rpc('authorize_and_record_mint', { p_child_id: childId })
  if (!az?.ok) return json({ denied: true, reason: az?.error ?? 'denied' }, 403)

  // 2. mint a single-use one-time link for the owned child + exchange it
  //    SERVER-SIDE. The link / token is never returned to the client.
  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const { data: cu } = await service.auth.admin.getUserById(az.auth_user_id)
  const email = cu?.user?.email
  if (!email) return json({ error: 'no_handle' }, 500)
  const { data: link, error: lErr } = await service.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link?.properties?.hashed_token) return json({ error: 'mint_failed' }, 500)
  const exch = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: sess, error: vErr } = await exch.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr || !sess?.session) return json({ error: 'exchange_failed' }, 500)

  return json({ access_token: sess.session.access_token, refresh_token: sess.session.refresh_token, child_id: childId })
})
