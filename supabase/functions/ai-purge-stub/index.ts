// ai-purge-stub — DEV-ONLY stand-in for a real no-train/ZDR AI provider's deletion
// endpoint (Phase 5 · Slice 1). It exists so the e2e exercises the REAL fetch + retry path
// in purgeAiProvider (not the mock branch). NEVER deployed to prod — the real endpoint is
// the provider's, wired via AI_PURGE_URL at the gate.
//
// STRONG BORDERS: it ONLY ever receives an opaque child uuid (subject_ref) — never a name
// or any child data; any other field is REJECTED. To prove the retry path deterministically
// (no reliance on isolate-persistent state) a single opaque uuid may be designated the
// FAIL_REF via env: it always returns 500 so the worker's real fetch + retry/park logic is
// exercised on a genuine failure. verify_jwt=false; shared-secret, fail-closed.
const SECRET = Deno.env.get('AI_PURGE_STUB_SECRET') ?? ''
const FAIL_REF = Deno.env.get('AI_PURGE_STUB_FAIL_REF') ?? '' // DEV: this opaque uuid always 500s
// STRUCTURAL "never in prod": inert (404) unless explicitly enabled in the DEV env. A bulk
// `supabase functions deploy` to prod (where this flag is unset) lands a dead endpoint, not
// a live stub — the claim is enforced, not aspirational.
const DEV_ENABLED = Deno.env.get('AI_PURGE_STUB_DEV') === '1'

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function authed(req: Request): boolean {
  const h = req.headers.get('Authorization') ?? ''
  const given = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!SECRET || given.length !== SECRET.length) return false
  let diff = 0
  for (let i = 0; i < SECRET.length; i++) diff |= given.charCodeAt(i) ^ SECRET.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (!DEV_ENABLED) return json({ error: 'not_available' }, 404) // structural DEV-only gate
  if (!authed(req)) return json({ error: 'unauthorized' }, 401)
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400)
  // opaque uuid ONLY — exactly {subject_ref}, nothing else
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'subject_ref') return json({ error: 'unexpected_field' }, 400)
  const ref = String((body as Record<string, unknown>).subject_ref)
  if (!UUID_RE.test(ref)) return json({ error: 'bad_subject' }, 400)
  if (FAIL_REF && ref === FAIL_REF) return json({ error: 'transient' }, 500) // drives a real retry/park
  return json({ ok: true })
})
