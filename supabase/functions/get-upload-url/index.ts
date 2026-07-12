// get-upload-url — Phase 4 · U2. Returns a SHORT-LIVED signed download URL for one
// upload, so the private bucket is never public. Authorization is the caller's OWN
// RLS: they select the uploads row through their user client, which only returns rows
// for children they can_view (+ active consent); a miss → 404. The signed URL is then
// minted with the service key (bucket is private) but only for that already-authorized
// object. 60-second TTL.
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

  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: who } = await caller.auth.getUser()
  if (!who?.user) return json({ error: 'unauthenticated' }, 401)

  const body = await req.json().catch(() => ({}))
  const uploadId = String(body?.uploadId ?? '')
  if (!uploadId) return json({ error: 'bad_request' }, 400)

  // AUTHORIZATION = the caller's RLS: only returns the row if they can_view the child.
  const { data: row } = await caller.from('uploads').select('storage_path').eq('id', uploadId).maybeSingle()
  if (!row?.storage_path) return json({ error: 'not_found' }, 404)

  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const { data: signed, error } = await service.storage.from('uploads').createSignedUrl(row.storage_path, 60)
  if (error || !signed?.signedUrl) return json({ error: 'sign_failed' }, 500)
  return json({ ok: true, url: signed.signedUrl })
})
