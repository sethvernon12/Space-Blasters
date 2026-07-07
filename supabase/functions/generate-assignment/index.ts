// generate-assignment — AI-3d, server-side. Caller's JWT only; NEVER a service
// key. SQL picks skill+difficulty (~85%); the model only renders wording; the
// solver validates every item; produces a PROPOSAL only (nothing delivered).
// Flow: authorize -> pick_assignment_plan (SQL, name-free) -> gateway renders
// each item's wording -> verify (no fabricated numbers) -> moderate -> propose.
import { runGateway } from '../_shared/gateway.ts'
import { verifyNumbers } from '../_shared/verify.ts'
import { moderate } from '../_shared/moderate.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!

async function rpc(name: string, auth: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  })
  if (!res.ok) return null
  return res.json()
}

const ACTION = 'ai.assignment.propose'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)
  const body = await req.json().catch(() => ({}))
  const childId = body?.childId
  if (!childId) return json({ error: 'bad_request' }, 400)

  // 1. authorize the write (fail-closed; denial audited)
  const az = await rpc('authorize', auth, { p_action: ACTION, p_child_id: childId })
  if (!az?.allow) {
    await rpc('write_audit', auth, { p_action: ACTION, p_child_id: childId, p_decision: 'deny', p_detail: { reason: az?.reason ?? 'denied' } })
    return json({ denied: true, reason: az?.reason ?? 'denied' }, 403)
  }

  // 2. SQL picks skill + difficulty + solver-answered items (deterministic, name-free)
  const plan = await rpc('pick_assignment_plan', auth, { p_child_id: childId })
  if (!plan || plan.denied) return json({ denied: true, reason: plan?.reason ?? 'plan_denied' }, 403)

  // 3. the model renders WORDING per item -> 4. verify (no fabricated numbers) -> 5. moderate
  const rendered = (plan.items ?? []).map((item: { operator: string; operands: number[]; correct_answer: number }) => {
    const gen = runGateway('assignment', { skill_display: plan.skill_display, item }, { promptVersion: 'assign-v1' })
    const allowed = new Set((item.operands ?? []).map(Number))            // the prompt may state operands, never the answer
    const verified = verifyNumbers(allowed, gen.text, /(\d+)/g, `Solve: ${(item.operands ?? []).join(` ${item.operator} `)} 🚀`)
    const safe = moderate(verified.text)
    return { ...item, prompt: safe.text }
  })

  // 6. propose (private, not authoritative) + 7. audit
  const prop = await rpc('propose_assignment', auth, {
    p_child_id: childId, p_skill_id: plan.skill_id, p_difficulty: plan.difficulty, p_predicted_p: plan.predicted_p,
    p_items: rendered, p_title: `Practice: ${plan.skill_display}`, p_model: 'deterministic-v1', p_prompt_version: 'assign-v1',
  })
  if (!prop?.ok) return json({ denied: true, reason: prop?.error ?? 'propose_failed' }, 403)
  await rpc('write_audit', auth, {
    p_action: ACTION, p_child_id: childId, p_decision: 'allow',
    p_detail: { model: 'deterministic-v1', prompt_version: 'assign-v1', predicted_p: plan.predicted_p, item_count: rendered.length, proposal_id: prop.proposal_id },
  })
  return json({ proposal_id: prop.proposal_id, skill: plan.skill_display, predicted_p: plan.predicted_p, prompts: rendered.map((r: { prompt: string }) => r.prompt) })
})
