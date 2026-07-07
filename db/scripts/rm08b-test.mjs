// ============================================================================
// RM-08b self-test — generateAssignment (AI-3d) on the proposal-behind-approval
// path. DB-level, real client path (anon key + user JWT, RLS). LOCAL only.
// (The full gateway render is exercised in rm08b-e2e.mjs; here propose_assignment
// stands in for the gateway's service write.)
//
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm08b-test.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

const { Client } = pgpkg
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId }
const db = new Client({ connectionString: cfg.dbUrl })
const q = (sql, p = []) => db.query(sql, p)

console.log('Setup + Brielle has some mastery…')
const uids = await setupFamily(cfg)
await db.connect()
const S = {}
for (const [w, e] of [['seth', A.parent.email], ['brielle', A.children.brielle.email], ['rose', A.tutor.email], ['dana', B.parent.email]]) S[w] = await signInAs(cfg, e)
{
  const ses = uuid()
  await S.brielle.client.rpc('record_attempts_authed', { p_child_id: CID.Brielle, p_batch: buildBatch(Array.from({ length: 8 }, (_, i) => ({ clientAttemptId: uuid(), clientSessionId: ses, stageIndex: 0, skill: 'addition', result: i === 5 ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: i, level: 1, mode: 'journey', context: {} }))) })
}

// ---- AI-3d: SQL picks skill + difficulty (~85%); items carry solver answers ----
console.log('AI-3d (SQL picks skill + solver-answered items):')
const plan = (await S.rose.client.rpc('pick_assignment_plan', { p_child_id: CID.Brielle })).data
{
  const items = plan?.items ?? []
  const solverValid = items.every((it) => {
    const [a, b] = it.operands
    const exp = it.operator === '+' ? a + b : it.operator === '-' ? a - b : a * b
    return it.correct_answer === exp
  })
  plan?.skill_id === 'add5' && items.length === 4 && solverValid && plan.predicted_p > 0 && plan.predicted_p <= 1
    ? ok(`plan: focus=${plan.skill_id}, ${items.length} items, every correct_answer = solver, predicted_p=${plan.predicted_p}`) : bad(`plan: ${JSON.stringify(plan)}`)
}

// ---- propose (private) + ACC-05: nothing delivered until approval ----
console.log('AI proposal is private; nothing delivered until approval (ACC-05):')
const prop = (await S.rose.client.rpc('propose_assignment', { p_child_id: CID.Brielle, p_skill_id: plan.skill_id, p_difficulty: plan.difficulty, p_predicted_p: plan.predicted_p, p_items: plan.items, p_title: 'Practice: Add within 5', p_model: 'deterministic-v1', p_prompt_version: 'assign-v1' })).data
{
  const art = (await q(`select author_role, visibility_scope from public.teaching_artifacts where id=$1`, [prop.proposal_id])).rows[0]
  const delivered = (await q(`select count(*)::int n from public.assignments where child_id=$1 and items is not null`, [CID.Brielle])).rows[0].n
  const childSees = (await S.brielle.client.from('assignments').select('id').eq('child_id', CID.Brielle)).data ?? []
  const childSeesProp = (await S.brielle.client.from('teaching_artifacts').select('id').eq('id', prop.proposal_id)).data ?? []
  prop?.ok && art?.author_role === 'ai' && art?.visibility_scope === 'private' && delivered === 0 && childSees.length === 0 && childSeesProp.length === 0
    ? ok('proposal is a private ai artifact; NO delivered assignment; the child sees neither') : bad(`ACC-05: ${JSON.stringify({ art, delivered, childSees: childSees.length, prop: childSeesProp.length })}`)
  const pend = (await S.rose.client.rpc('pending_assignments')).data ?? []
  pend.some((p) => p.id === prop.proposal_id) ? ok('proposal appears in the tutor approvals queue') : bad('not in queue')
}

// ---- approval DELIVERS (child-visible, answer-free) ----
console.log('approve_assignment delivers (the only path):')
{
  const r = (await S.rose.client.rpc('approve_assignment', { p_proposal_id: prop.proposal_id, p_override_title: null })).data
  const del = (await q(`select id, status, items from public.assignments where id=$1`, [r?.assignment_id])).rows[0]
  const answerFree = (del?.items ?? []).every((it) => it.correct_answer === undefined && it.prompt !== undefined)
  const childSees = (await S.brielle.client.from('assignments').select('id,status').eq('child_id', CID.Brielle)).data ?? []
  const audit = (await q(`select count(*)::int n from public.audit_log where action='ai.assignment.approve' and child_id=$1`, [CID.Brielle])).rows[0].n
  r?.ok && del?.status === 'assigned' && answerFree && childSees.length === 1 && audit >= 1
    ? ok('delivered assignment (status assigned, ANSWER-FREE items) is now child-visible; audit written') : bad(`approve: ${JSON.stringify({ r, del, answerFree, childSees: childSees.length, audit })}`)
}

// ---- solver re-validates every item at approval — a tampered item is rejected ----
console.log('solver validates at the record boundary:')
{
  const bad2 = (await S.rose.client.rpc('propose_assignment', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_difficulty: 'x', p_predicted_p: 0.8, p_items: [{ operator: '+', operands: [2, 3], correct_answer: 99 }], p_title: 'tampered', p_model: 'x', p_prompt_version: 'x' })).data
  const r = (await S.rose.client.rpc('approve_assignment', { p_proposal_id: bad2.proposal_id })).data
  const delivered = (await q(`select count(*)::int n from public.assignments where title='tampered'`)).rows[0].n
  r?.error === 'invalid_items' && delivered === 0 ? ok('a tampered item (wrong answer) is REJECTED at approval — never delivered') : bad(`re-validate: ${JSON.stringify({ r, delivered })}`)
}

// ---- M7 (0011): every delivered prompt passes the moderation choke point ----
console.log('M7 (moderation on delivery):')
{
  const propM = (await S.rose.client.rpc('propose_assignment', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_difficulty: 'x', p_predicted_p: 0.8, p_items: [{ operator: '+', operands: [2, 3], correct_answer: 5, prompt: 'Solve 2 + 3 — visit http://cheats.example.com' }], p_title: 'modtest', p_model: 'x', p_prompt_version: 'x' })).data
  const r = (await S.rose.client.rpc('approve_assignment', { p_proposal_id: propM.proposal_id })).data
  const del = (await q(`select items from public.assignments where id=$1`, [r?.assignment_id])).rows[0]
  const clean = (del?.items ?? []).every((it) => !/cheats\.example\.com/.test(it.prompt ?? ''))
  r?.ok && clean ? ok('a link in a delivered prompt is MODERATED out on the authoritative path') : bad(`M7: ${JSON.stringify(del?.items)}`)
}

// ---- M7b (0012): the assignment TITLE is moderated on delivery ----
console.log('M7b (title moderation):')
{
  const propT = (await S.rose.client.rpc('propose_assignment', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_difficulty: 'x', p_predicted_p: 0.8, p_items: [{ operator: '+', operands: [2, 3], correct_answer: 5, prompt: 'What is 2 + 3?' }], p_title: 'Homework at http://evil.example.com', p_model: 'x', p_prompt_version: 'x' })).data
  const r = (await S.rose.client.rpc('approve_assignment', { p_proposal_id: propT.proposal_id })).data
  const del = (await q(`select title from public.assignments where id=$1`, [r?.assignment_id])).rows[0]
  r?.ok && !/evil\.example\.com/.test(del?.title ?? '') ? ok('a link in the assignment TITLE is moderated out on delivery') : bad(`M7b: title="${del?.title}"`)
}

// ---- DoS (0012): malformed item operands → invalid_items (graceful) ----
console.log('DoS (malformed item fails closed):')
{
  const propD = (await S.rose.client.rpc('propose_assignment', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_difficulty: 'x', p_predicted_p: 0.8, p_items: [{ operator: '+', operands: ['abc', 3], correct_answer: 5, prompt: 'x' }], p_title: 'dositem', p_model: 'x', p_prompt_version: 'x' })).data
  const r = (await S.rose.client.rpc('approve_assignment', { p_proposal_id: propD.proposal_id })).data
  const delivered = (await q(`select count(*)::int n from public.assignments where title='dositem'`)).rows[0].n
  r?.error === 'invalid_items' && delivered === 0 ? ok('non-numeric operands → invalid_items (graceful, not a thrown txn)') : bad(`DoS-assign: ${JSON.stringify({ r, delivered })}`)
}

// ---- KER-7: generation writes no mastery/consent ----
console.log('KER-7:')
{
  const mast = (await q(`select attempts_count from public.child_skill_mastery where child_id=$1 and skill_id='add5'`, [CID.Brielle])).rows[0]
  mast?.attempts_count === 8 ? ok('Beta mastery untouched by the assignment path (still 8 from the game)') : bad(`KER-7 mastery: ${JSON.stringify(mast)}`)
}

// ---- Isolation + revocation ----
console.log('Isolation + revocation:')
{
  const danaPlan = (await S.dana.client.rpc('pick_assignment_plan', { p_child_id: CID.Brielle })).data
  const danaApprove = (await S.dana.client.rpc('approve_assignment', { p_proposal_id: prop.proposal_id })).data
  danaPlan?.denied && danaApprove?.error === 'unknown_proposal' || danaApprove?.error === 'not_authorized'
    ? ok('other family cannot plan/approve for Brielle') : bad(`isolation: ${JSON.stringify({ danaPlan, danaApprove })}`)
  await S.seth.client.from('tutor_grants').update({ active: false }).eq('tutor_id', uids.rose).eq('child_id', CID.Brielle)
  const rosePlan = (await S.rose.client.rpc('pick_assignment_plan', { p_child_id: CID.Brielle })).data
  rosePlan?.denied ? ok('revoked tutor loses assignment generation') : bad(`revoked rose: ${JSON.stringify(rosePlan)}`)
}

await db.end()
console.log(fails ? `\n=== RM-08b: ${fails} FAIL ===` : '\n=== RM-08b: ALL PASS ===')
process.exit(fails ? 1 : 0)
