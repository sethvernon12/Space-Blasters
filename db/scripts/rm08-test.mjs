// ============================================================================
// RM-08 self-test — the AI teacher's-assistant GRADING loop (AI-3/AI-4, KER-7,
// ACC-05). DB-level, real client path (anon key + user JWT, RLS). LOCAL only.
// (The full gateway path — solver/mock/verify/moderate — is exercised in
// rm08-e2e.mjs; here propose_grade stands in for the gateway's service write.)
//
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm08-test.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

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

console.log('Setup + sign-in…')
const uids = await setupFamily(cfg)
await db.connect()
const S = {}
for (const [w, e] of [['seth', A.parent.email], ['brielle', A.children.brielle.email], ['rose', A.tutor.email], ['dana', B.parent.email]]) S[w] = await signInAs(cfg, e)

const submit = async (client, answer, expl = 'I worked it out') =>
  (await client.rpc('record_submission', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: { operator: '+', operands: [2, 3], correct_answer: 5 }, p_submitted_answer: answer, p_explanation: expl })).data

// ---- child submits graded work (immutable raw work) ----
console.log('record_submission (raw work):')
const sub1 = (await submit(S.brielle.client, 5)).submission_id
sub1 ? ok('Brielle submitted graded work (answer 5)') : bad('record_submission failed')

// ---- AI proposal (private, NOT authoritative) + ACC-05 ----
console.log('AI proposal is private + nothing recorded until approval (ACC-05):')
const prop1 = (await S.rose.client.rpc('propose_grade', { p_submission_id: sub1, p_verdict: 'correct', p_score: 100, p_feedback: 'Nice work on Add within 5!', p_model: 'deterministic-v1', p_prompt_version: 'grade-v1', p_misconception_id: null })).data
{
  const art = (await q(`select author_role, visibility_scope from public.teaching_artifacts where id=$1`, [prop1.proposal_id])).rows[0]
  const gradeEv = (await q(`select count(*)::int n from public.events where kind='grade' and subject_child_id=$1`, [CID.Brielle])).rows[0].n
  const childFb = (await q(`select count(*)::int n from public.teaching_artifacts where kind='feedback' and child_id=$1`, [CID.Brielle])).rows[0].n
  const assess = (await q(`select count(*)::int n from public.child_skill_assessment where child_id=$1`, [CID.Brielle])).rows[0].n
  prop1?.ok && art?.author_role === 'ai' && art?.visibility_scope === 'private' && gradeEv === 0 && childFb === 0 && assess === 0
    ? ok('proposal is a private ai artifact; NO grade Event / child feedback / projection yet') : bad(`ACC-05: ${JSON.stringify({ art, gradeEv, childFb, assess })}`)
  const pend = (await S.rose.client.rpc('pending_grades')).data ?? []
  const brielleSees = (await S.brielle.client.from('teaching_artifacts').select('id').eq('id', prop1.proposal_id)).data ?? []
  pend.some((p) => p.id === prop1.proposal_id) && brielleSees.length === 0 ? ok('proposal in tutor approvals queue; the CHILD cannot see the private proposal') : bad(`queue/child-visibility: pend=${pend.length} child=${brielleSees.length}`)
}

// ---- human approval RECORDS the grade (+ child feedback + projection) ----
console.log('approve_grade RECORDS (the only path):')
{
  const r = (await S.rose.client.rpc('approve_grade', { p_proposal_id: prop1.proposal_id, p_override_feedback: null })).data
  const gradeEv = (await q(`select payload->>'verdict' v from public.events where kind='grade' and payload->>'ai_proposal_id'=$1`, [prop1.proposal_id])).rows[0]
  const fb = (await q(`select visibility_scope, payload->>'feedback' f from public.teaching_artifacts where kind='feedback' and supersedes_id=$1`, [prop1.proposal_id])).rows[0]
  const assess = (await q(`select graded_count, correct_count from public.child_skill_assessment where child_id=$1 and skill_id='add5'`, [CID.Brielle])).rows[0]
  const audit = (await q(`select count(*)::int n from public.audit_log where action='ai.grade.approve' and child_id=$1`, [CID.Brielle])).rows[0].n
  r?.ok && gradeEv?.v === 'correct' && fb?.visibility_scope === 'sent-to-child' && assess?.graded_count === 1 && assess?.correct_count === 1 && audit >= 1
    ? ok('grade Event (verdict correct) + sent-to-child feedback + assessment(1/1) + audit written') : bad(`approve: ${JSON.stringify({ r, gradeEv, fb, assess, audit })}`)
}

// ---- AI-4: the deterministic SOLVER arbitrates, not the model ----
console.log('AI-4 (solver arbitrates numeric correctness):')
{
  const sub2 = (await submit(S.brielle.client, 4)).submission_id // WRONG answer
  const prop2 = (await S.rose.client.rpc('propose_grade', { p_submission_id: sub2, p_verdict: 'correct', p_score: 100, p_feedback: 'Looks right!', p_model: 'x', p_prompt_version: 'grade-v1', p_misconception_id: null })).data // AI wrongly says correct
  const r = (await S.rose.client.rpc('approve_grade', { p_proposal_id: prop2.proposal_id })).data
  r?.verdict === 'incorrect' ? ok('AI proposed "correct" on a wrong answer → RECORDED verdict = solver\'s "incorrect"') : bad(`solver-arbiter: recorded verdict=${r?.verdict}`)
}

// ---- H3 (0011): a client-forged correct_answer is IGNORED (recompute from operands)
console.log('H3 (forged correct_answer ignored):')
{
  const subF = (await S.brielle.client.rpc('record_submission', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: { operator: '+', operands: [2, 3], correct_answer: 4 }, p_submitted_answer: 4, p_explanation: 'x' })).data.submission_id
  const propF = (await S.rose.client.rpc('propose_grade', { p_submission_id: subF, p_verdict: 'correct', p_score: 100, p_feedback: 'ok', p_model: 'x', p_prompt_version: 'x', p_misconception_id: null })).data
  const r = (await S.rose.client.rpc('approve_grade', { p_proposal_id: propF.proposal_id })).data
  r?.verdict === 'incorrect' ? ok('forged correct_answer=4 for 2+3 → solver recomputes 5 → RECORDED incorrect (no self-certify)') : bad(`H3: verdict=${r?.verdict}`)
}

// ---- override changes feedback only; moderate() on the child-facing string ----
console.log('override (feedback only) + moderate:')
{
  const sub3 = (await submit(S.brielle.client, 5)).submission_id
  const prop3 = (await S.rose.client.rpc('propose_grade', { p_submission_id: sub3, p_verdict: 'correct', p_score: 100, p_feedback: 'ok', p_model: 'x', p_prompt_version: 'grade-v1', p_misconception_id: null })).data
  const r = (await S.rose.client.rpc('approve_grade', { p_proposal_id: prop3.proposal_id, p_override_feedback: 'Great effort! visit http://cheats.example.com for more' })).data
  const fb = (await q(`select payload->>'feedback' f from public.teaching_artifacts where kind='feedback' and supersedes_id=$1`, [prop3.proposal_id])).rows[0]
  r?.verdict === 'correct' && r?.overridden === true && !/cheats\.example\.com/.test(fb?.f ?? '') ? ok('override feedback stored, verdict stays solver\'s, link MODERATED out') : bad(`override/moderate: verdict=${r?.verdict} fb="${fb?.f}"`)
}

// ---- SAF-08: raw work immutable ----
console.log('SAF-08 (raw work immutable):')
{
  let e = null
  try { await q(`update public.submissions set submitted_answer=99 where id=$1`, [sub1]) } catch (err) { e = err.message }
  let e2 = null
  try { await q(`delete from public.submissions where id=$1`, [sub1]) } catch (err) { e2 = err.message }
  e && e2 ? ok('UPDATE and DELETE on submissions are blocked (append-only)') : bad(`immutability: upd=${!!e} del=${!!e2}`)
}

// ---- KER-7: AI/grading never writes mastery / consent / projection directly ----
console.log('KER-7 (AI cannot write mastery/consent/projection):')
{
  const mast = (await q(`select count(*)::int n from public.child_skill_mastery where child_id=$1`, [CID.Brielle])).rows[0].n
  const assessInsert = await S.rose.client.from('child_skill_assessment').insert({ child_id: CID.Brielle, skill_id: 'add5', graded_count: 99 }).select()
  mast === 0 && (assessInsert.error || !assessInsert.data?.length) ? ok('grading left Beta mastery untouched; direct projection write blocked (definer-only)') : bad(`KER-7: mastery=${mast} assessInsert=${!assessInsert.error}`)
}

// ---- DATA-4: projection recomputable by replay (reconcile) ----
console.log('DATA-4 (reconcile):')
{
  const before = (await q(`select graded_count, correct_count from public.child_skill_assessment where child_id=$1 and skill_id='add5'`, [CID.Brielle])).rows[0]
  await S.seth.client.rpc('rebuild_assessment', { p_child_id: CID.Brielle })
  const after = (await q(`select graded_count, correct_count from public.child_skill_assessment where child_id=$1 and skill_id='add5'`, [CID.Brielle])).rows[0]
  before && after && before.graded_count === after.graded_count && before.correct_count === after.correct_count
    ? ok(`replay rebuild matches stored projection (graded=${after.graded_count}, correct=${after.correct_count})`) : bad(`reconcile: ${JSON.stringify({ before, after })}`)
}

// ---- M5 (0011): approval is idempotent per submission (no double-count) ----
console.log('M5 (idempotent approval):')
{
  const before = (await q(`select graded_count from public.child_skill_assessment where child_id=$1 and skill_id='add5'`, [CID.Brielle])).rows[0]?.graded_count ?? 0
  const dup = (await S.rose.client.rpc('approve_grade', { p_proposal_id: prop1.proposal_id })).data // prop1 was already approved
  const after = (await q(`select graded_count from public.child_skill_assessment where child_id=$1 and skill_id='add5'`, [CID.Brielle])).rows[0]?.graded_count ?? 0
  dup?.error === 'already_recorded' && before === after ? ok('re-approving a recorded grade → already_recorded, projection unchanged') : bad(`M5: dup=${JSON.stringify(dup)} ${before}->${after}`)
}

// ---- M6 (0011): rebuild_assessment requires active consent (blocks after revocation)
console.log('M6 (rebuild requires consent):')
{
  const saved = (await q(`select consent_id from public.children where id=$1`, [CID.Brielle])).rows[0].consent_id
  await q(`update public.children set consent_id=null where id=$1`, [CID.Brielle])
  const r = (await S.seth.client.rpc('rebuild_assessment', { p_child_id: CID.Brielle })).data
  r?.error === 'no_consent' ? ok('rebuild_assessment blocked when consent missing/revoked (no re-materialization)') : bad(`M6: ${JSON.stringify(r)}`)
  await q(`update public.children set consent_id=$1 where id=$2`, [saved, CID.Brielle])
}

// ---- DoS (0012): malformed problem_dna grades incorrect, never crashes ----
console.log('DoS (malformed DNA fails closed):')
{
  const subD = (await S.brielle.client.rpc('record_submission', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: { operator: '+', operands: ['abc', 3], correct_answer: 4 }, p_submitted_answer: 4, p_explanation: 'x' })).data.submission_id
  const propD = (await S.rose.client.rpc('propose_grade', { p_submission_id: subD, p_verdict: 'correct', p_score: 100, p_feedback: 'x', p_model: 'x', p_prompt_version: 'x', p_misconception_id: null })).data
  const r = (await S.rose.client.rpc('approve_grade', { p_proposal_id: propD.proposal_id })).data
  r?.ok && r?.verdict === 'incorrect' ? ok('non-numeric operands → recorded incorrect (graceful, no thrown txn)') : bad(`DoS-grade: ${JSON.stringify(r)}`)
}

// ---- M5b (0012): unique index blocks a duplicate grade event for a submission ----
console.log('M5b (grade-per-submission unique backstop):')
{
  let e = null
  try { await q(`insert into public.events (kind, author_actor_id, subject_child_id, payload) values ('grade',$1,$2, jsonb_build_object('submission_id',$3::text,'verdict','correct'))`, [uids.seth, CID.Brielle, sub1]) } catch (err) { e = err.message }
  e ? ok('a second grade event for the same submission is rejected (unique index)') : bad('M5b: duplicate grade insert allowed')
}

// ---- Isolation + revocation ----
console.log('Isolation + revocation:')
{
  const danaSubmit = (await S.dana.client.rpc('record_submission', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: {}, p_submitted_answer: 5 })).data
  const danaPropose = (await S.dana.client.rpc('propose_grade', { p_submission_id: sub1, p_verdict: 'correct', p_score: 100, p_feedback: 'x', p_model: 'x', p_prompt_version: 'x', p_misconception_id: null })).data
  const danaReads = (await S.dana.client.from('submissions').select('id').eq('child_id', CID.Brielle)).data ?? []
  danaSubmit?.error === 'not_authorized' && danaPropose?.error === 'not_authorized' && danaReads.length === 0
    ? ok('other family cannot submit/propose/read for Brielle') : bad(`isolation: ${JSON.stringify({ danaSubmit, danaPropose, reads: danaReads.length })}`)
  await S.seth.client.from('tutor_grants').update({ active: false }).eq('tutor_id', uids.rose).eq('child_id', CID.Brielle)
  const roseAfter = (await S.rose.client.rpc('propose_grade', { p_submission_id: sub1, p_verdict: 'correct', p_score: 100, p_feedback: 'x', p_model: 'x', p_prompt_version: 'x', p_misconception_id: null })).data
  roseAfter?.error === 'not_authorized' ? ok('revoked tutor loses grading (propose → not_authorized)') : bad(`revoked rose: ${JSON.stringify(roseAfter)}`)
}

await db.end()
console.log(fails ? `\n=== RM-08: ${fails} FAIL ===` : '\n=== RM-08: ALL PASS ===')
process.exit(fails ? 1 : 0)
