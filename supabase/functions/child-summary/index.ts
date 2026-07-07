// child-summary — the AI gateway + the full "secure the yard" spine, server-side.
// Uses ONLY the caller's JWT (forwarded to the RPCs); NEVER a service-role key.
// Flow: authorize (fail-closed) -> child_context_pack (whitelist, no name) ->
// gateway.generate (mock, fail-closed to a ZDR-eligible provider) -> verify
// (deterministic, no fabricated numbers) -> moderate (choke point) -> audit.
import { generateSummary } from './gateway/index.ts'
import { verifyClaims } from './verify.ts'
import { moderate } from './moderate.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!

// Call a Postgres RPC as the CALLER (forward their JWT). No service-role key.
async function rpc(name: string, auth: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) return null
  return res.json()
}

const ACTION = 'child.summary.read'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)
  const body = await req.json().catch(() => ({}))
  const childId = body?.childId
  if (!childId) return json({ error: 'bad_request' }, 400)

  // 1. authorize — the fail-closed gate (consent + scope + isolation)
  const az = await rpc('authorize', auth, { p_action: ACTION, p_child_id: childId })
  if (!az?.allow) {
    await rpc('write_audit', auth, { p_action: ACTION, p_child_id: childId, p_decision: 'deny', p_detail: { reason: az?.reason ?? 'denied' } })
    return json({ denied: true, reason: az?.reason ?? 'denied' }, 403)
  }

  // 2. context pack — the ONLY thing the AI sees; opaque, no name
  const pack = await rpc('child_context_pack', auth, { p_child_id: childId })
  if (!pack || pack.denied) {
    await rpc('write_audit', auth, { p_action: ACTION, p_child_id: childId, p_decision: 'deny', p_detail: { reason: pack?.reason ?? 'pack_denied' } })
    return json({ denied: true, reason: pack?.reason ?? 'pack_denied' }, 403)
  }

  // 3. AI gateway (mock; fails closed if no ZDR-eligible provider)
  const gen = generateSummary(pack, { promptVersion: 'summary-v1' })
  // 4. deterministic-solver verify (no fabricated numbers) + 5. moderate choke point
  const verified = verifyClaims(pack, gen.text)
  const safe = moderate(verified.text)

  // 6. audit — append-only who/what/when + model/prompt version
  await rpc('write_audit', auth, {
    p_action: ACTION, p_child_id: childId, p_decision: 'allow',
    p_detail: { provider: gen.provider, model: gen.model, prompt_version: 'summary-v1', moderation: safe.flagged ? 'redacted' : 'pass', verified: verified.ok },
  })
  return json({ summary: safe.text, meta: { provider: gen.provider, model: gen.model, promptVersion: 'summary-v1' } })
})
