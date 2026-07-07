// grade-work — the AI teacher's-assistant PRE-GRADE, server-side. Caller's JWT
// only; NEVER a service-role key. Produces a PROPOSAL only (nothing recorded).
// Flow: read the submission (RLS, name-free) -> authorize (can_write) ->
// deterministic SOLVER decides correctness (the arbiter, AI-4) -> mock gateway
// renders feedback -> verify (no fabricated numbers) -> moderate (child-facing)
// -> propose_grade (private artifact) -> audit. A human must approve to record.
import { runGateway } from '../_shared/gateway.ts'
import { verifyNumbers } from '../_shared/verify.ts'
import { moderate } from '../_shared/moderate.ts'
import { solveMath } from '../_shared/solver.ts'

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

const ACTION = 'ai.grade.propose'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthenticated' }, 401)
  const body = await req.json().catch(() => ({}))
  const submissionId = body?.submissionId
  if (!submissionId) return json({ error: 'bad_request' }, 400)

  // 1. read the submission through RLS (name-free: no name column exists)
  const subRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${submissionId}&select=child_id,skill_id,submitted_answer,problem_dna,skills(display_name)`,
    { headers: { apikey: ANON, Authorization: auth } })
  const sub = subRes.ok ? (await subRes.json())[0] : null
  if (!sub) return json({ denied: true, reason: 'not_visible' }, 403)
  const childId = sub.child_id

  // 2. authorize the WRITE (fail-closed); a denied attempt is audited
  const az = await rpc('authorize', auth, { p_action: ACTION, p_child_id: childId })
  if (!az?.allow) {
    await rpc('write_audit', auth, { p_action: ACTION, p_child_id: childId, p_decision: 'deny', p_detail: { reason: az?.reason ?? 'denied' } })
    return json({ denied: true, reason: az?.reason ?? 'denied' }, 403)
  }

  // 3. the deterministic SOLVER is the arbiter (AI-4)
  const solved = solveMath(sub.problem_dna, sub.submitted_answer)
  const skillDisplay = sub.skills?.display_name ?? sub.skill_id
  // 4. gateway renders feedback (mock; ZDR fail-closed)
  const gen = runGateway('grade', { skill_display: skillDisplay, correct: solved.correct, correct_answer: solved.correctAnswer, submitted_answer: sub.submitted_answer }, { promptVersion: 'grade-v1' })
  // 5. verify (no fabricated numbers) + 6. moderate (child-facing)
  const allowed = new Set([solved.correctAnswer, sub.submitted_answer, 0, 100].filter((n) => n != null && !Number.isNaN(Number(n))).map(Number))
  const verified = verifyNumbers(allowed, gen.text, /(\d+)/g, 'See your teacher’s notes for the details on this one.')
  const safe = moderate(verified.text)
  const verdict = solved.correct ? 'correct' : 'incorrect'

  // 7. write the PROPOSAL (private, not authoritative)
  const prop = await rpc('propose_grade', auth, {
    p_submission_id: submissionId, p_verdict: verdict, p_score: solved.correct ? 100 : 0,
    p_feedback: safe.text, p_model: gen.model, p_prompt_version: 'grade-v1', p_misconception_id: null,
  })
  if (!prop?.ok) return json({ denied: true, reason: prop?.error ?? 'propose_failed' }, 403)

  // 8. audit
  await rpc('write_audit', auth, {
    p_action: ACTION, p_child_id: childId, p_decision: 'allow',
    p_detail: { provider: gen.provider, model: gen.model, prompt_version: 'grade-v1', verdict, proposal_id: prop.proposal_id, moderation: safe.flagged ? 'redacted' : 'pass', verified: verified.ok },
  })
  return json({ proposal_id: prop.proposal_id, verdict, feedback: safe.text, meta: { provider: gen.provider, model: gen.model, promptVersion: 'grade-v1' } })
})
