// ============================================================================
// B1 self-test — the accounts/auth foundation on the LOCAL stack.
// Mints real GoTrue sessions for parent/child/tutor across two families and
// proves, through the REAL client path (anon key + user JWT, RLS enforced):
//   * each role's `children` read returns EXACTLY the right set (cross-family: none)
//   * record_attempts_authed authorizes writes by is_my_child (tutor/cross = forbidden)
//   * assignments: a tutor can assign for a GRANTED child only
// Service key is used only to mint users + seed (family.mjs), never in a client.
//
// Run (stack up):  eval "$(supabase status -o env)"; node db/scripts/family-b1-test.mjs
// ============================================================================
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'
import { createClient } from '@supabase/supabase-js'

let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const cfg = m3Config()
console.log('Setting up two families on the local stack (minting sessions)…')
const uids = await setupFamily(cfg)

const A = FAMILY.alpha, B = FAMILY.beta
const CID = { brielle: A.children.brielle.childId, theo: A.children.theo.childId, wren: B.children.wren.childId }

// ---- A. sessions mint + auth.uid resolves ----
console.log('A. minted sessions resolve to the right auth.uid:')
const S = {}
for (const [who, email] of [
  ['seth', A.parent.email], ['rose', A.tutor.email], ['obs', A.observer.email],
  ['brielle', A.children.brielle.email], ['theo', A.children.theo.email],
  ['dana', B.parent.email], ['wren', B.children.wren.email],
]) {
  const s = await signInAs(cfg, email)
  S[who] = s
  s.uid === uids[who] ? ok(`${who}: signed in, auth.uid matches`) : bad(`${who}: uid ${s.uid} != ${uids[who]}`)
}

// ---- B. children read scoping (RLS) ----
console.log('B. `children` read is scoped per role:')
async function kidsSeenBy(client) {
  const { data, error } = await client.from('children').select('nickname').order('nickname')
  if (error) throw new Error(error.message)
  return data.map((r) => r.nickname).sort()
}
const expect = [
  ['seth (parent A)', S.seth, ['Brielle', 'Theo']],
  ['brielle (child)', S.brielle, ['Brielle']],
  ['theo (child)', S.theo, ['Theo']],
  ['rose (tutor→Brielle)', S.rose, ['Brielle']],
  ['obs (observer→Brielle)', S.obs, ['Brielle']],
  ['dana (parent B)', S.dana, ['Wren']],
  ['wren (child)', S.wren, ['Wren']],
]
for (const [label, s, want] of expect) {
  const got = await kidsSeenBy(s.client)
  eq(got, want) ? ok(`${label} sees exactly [${want}]`) : bad(`${label} sees [${got}] — expected [${want}]`)
}

// ---- C. record_attempts_authed authorization (write path) ----
console.log('C. record_attempts_authed authorizes by is_my_child:')
function freshBatch() {
  return buildBatch([{
    clientAttemptId: uuid(), clientSessionId: uuid(), stageIndex: 0, skill: 'addition',
    result: 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5,
    responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: 5, level: 1,
    mode: 'journey', context: { source: 'm3-b1' },
  }])
}
async function writeAs(client, childId) {
  const { data, error } = await client.rpc('record_attempts_authed', { p_child_id: childId, p_batch: freshBatch() })
  return { data, error }
}
{
  const r = await writeAs(S.brielle.client, CID.brielle)
  r.data?.ok && r.data.inserted === 1 ? ok('brielle records for HERSELF → inserted 1') : bad(`brielle self-write: ${JSON.stringify(r.data || r.error?.message)}`)
}
{
  const r = await writeAs(S.seth.client, CID.brielle)
  r.data?.ok && r.data.inserted === 1 ? ok('seth (parent) records for Brielle → inserted 1') : bad(`seth→brielle: ${JSON.stringify(r.data || r.error?.message)}`)
}
{
  const r = await writeAs(S.rose.client, CID.brielle)
  r.data?.error === 'forbidden' ? ok('rose (tutor) records for Brielle → forbidden (tutors are read-only)') : bad(`rose→brielle should be forbidden: ${JSON.stringify(r.data || r.error?.message)}`)
}
{
  const r = await writeAs(S.dana.client, CID.brielle)
  r.data?.error === 'forbidden' ? ok('dana (other family) records for Brielle → forbidden') : bad(`dana→brielle should be forbidden: ${JSON.stringify(r.data || r.error?.message)}`)
}
{
  const anon = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false } })
  const { data, error } = await anon.rpc('record_attempts_authed', { p_child_id: CID.brielle, p_batch: freshBatch() })
  ;(error || data?.ok === false) ? ok('anon (no session) → blocked') : bad(`anon write should be blocked: ${JSON.stringify(data)}`)
}

// ---- D. assignments: tutor can assign for GRANTED child only ----
console.log('D. assignments enforce granted-only:')
async function assign(client, childId, uid) {
  return client.from('assignments').insert({ child_id: childId, assigned_by: uid, skill_id: 'add5', title: 'Practice adding within 5' }).select()
}
{
  const { data, error } = await assign(S.rose.client, CID.brielle, uids.rose)
  !error && data?.length === 1 ? ok('rose assigns for Brielle (granted) → created') : bad(`rose→Brielle assign failed: ${error?.message}`)
}
{
  const { data, error } = await assign(S.rose.client, CID.theo, uids.rose)
  ;(error || !data?.length) ? ok('rose assigns for Theo (NOT granted) → blocked by RLS') : bad(`rose→Theo assign should be blocked, got ${JSON.stringify(data)}`)
}
{
  const { data, error } = await assign(S.seth.client, CID.theo, uids.seth)
  !error && data?.length === 1 ? ok('seth (parent) assigns for her own Theo → created') : bad(`seth→Theo assign failed: ${error?.message}`)
}

// ---- E. teaching_artifacts: tutor teaching WRITE-power, scoped + truthful ----
console.log('E. teaching_artifacts write authorization (can_write_child):')
async function artifact(client, childId, uid, role, kind, extra = {}) {
  return client.from('teaching_artifacts')
    .insert({ child_id: childId, author_id: uid, author_role: role, kind, subject: 'math', payload: { note: 'from B1' }, ...extra })
    .select()
}
{
  const kinds = ['grade', 'feedback', 'annotation', 'reteach', 'material']
  let allOk = true
  for (const k of kinds) { const { data, error } = await artifact(S.rose.client, CID.brielle, uids.rose, 'tutor', k); if (error || data?.length !== 1) allOk = false }
  allOk ? ok('rose (tutor) creates grade/feedback/annotation/reteach/material for Brielle → all created') : bad('rose teaching writes for Brielle failed')
}
{
  const { data, error } = await artifact(S.seth.client, CID.brielle, uids.seth, 'parent', 'feedback')
  !error && data?.length === 1 ? ok('seth (parent) authors feedback for Brielle → created') : bad(`seth feedback: ${error?.message}`)
}
{
  const { data, error } = await artifact(S.rose.client, CID.theo, uids.rose, 'tutor', 'grade')
  ;(error || !data?.length) ? ok('rose creates artifact for Theo (not granted) → blocked') : bad('rose→Theo artifact should be blocked')
}
{
  const { data, error } = await artifact(S.dana.client, CID.brielle, uids.dana, 'tutor', 'grade')
  ;(error || !data?.length) ? ok('dana (other family) creates artifact for Brielle → blocked') : bad('dana→Brielle artifact should be blocked')
}
{
  const { data, error } = await artifact(S.obs.client, CID.brielle, uids.obs, 'tutor', 'feedback')
  ;(error || !data?.length) ? ok('obs (view-only grant, can_write=false) → blocked (reads but cannot write)') : bad('obs write should be blocked')
}
{
  const { data, error } = await artifact(S.rose.client, CID.brielle, uids.rose, 'parent', 'grade') // masquerade
  ;(error || !data?.length) ? ok('rose claims author_role=parent (masquerade) → blocked (truthful provenance)') : bad('rose parent-masquerade should be blocked')
}

// ---- F. immutable + supersede-to-revoke (override = new row, never an edit) ----
console.log('F. teaching_artifacts immutable; override = superseding row:')
let firstGradeId = null
{
  const { data } = await artifact(S.rose.client, CID.brielle, uids.rose, 'tutor', 'grade', { payload: { verdict: 'incorrect' } })
  firstGradeId = data?.[0]?.id
  const { data: d2, error } = await artifact(S.rose.client, CID.brielle, uids.rose, 'tutor', 'grade', { payload: { verdict: 'correct' }, supersedes_id: firstGradeId })
  !error && d2?.length === 1 && firstGradeId ? ok('rose overrides her grade with a SUPERSEDING row → both preserved') : bad('supersede failed')
}
{
  const { data, error } = await S.rose.client.from('teaching_artifacts').update({ payload: { hacked: true } }).eq('id', firstGradeId).select()
  ;(error || !data?.length) ? ok('UPDATE a teaching_artifact → blocked (immutable)') : bad('update should be blocked')
}
{
  const { data, error } = await S.rose.client.from('teaching_artifacts').delete().eq('id', firstGradeId).select()
  ;(error || !data?.length) ? ok('DELETE a teaching_artifact → blocked (immutable)') : bad('delete should be blocked')
}

// ---- G. STILL LOCKED for the tutor: raw attempts / mastery / consent ----
console.log('G. tutor cannot touch attempts / mastery / consent:')
{
  const { data, error } = await S.rose.client.from('attempts').update({ result: 'correct' }).eq('child_id', CID.brielle).select()
  ;(error || !data?.length) ? ok('rose UPDATE attempts → blocked (append-only, no policy)') : bad('rose attempts update should be blocked')
}
{
  const { error } = await S.rose.client.from('child_skill_mastery')
    .insert({ child_id: CID.brielle, skill_id: 'add5', alpha: 99, beta: 1 }).select()
  error ? ok('rose INSERT mastery → blocked (no client write path)') : bad('rose mastery insert should be blocked')
}
{
  const { error } = await S.rose.client.from('consent_ledger')
    .insert({ parent_id: uids.rose, child_id: CID.brielle, action: 'grant', method: 'other_vpc', policy_version: 'x' }).select()
  error ? ok('rose INSERT consent_ledger → blocked (service-only)') : bad('rose consent insert should be blocked')
}

// ---- H. every tutor grant logged as a parental-disclosure consent event ----
console.log('H. tutor grants logged as disclosure events:')
{
  const { data, error } = await S.seth.client.from('consent_ledger').select('action, child_id, detail').eq('action', 'disclosure')
  if (error) { bad(`seth consent read: ${error.message}`) }
  else {
    const grantees = data.map((r) => r.detail?.grantee_id)
    const hasRose = data.some((r) => r.detail?.grantee_id === uids.rose && r.child_id === CID.brielle)
    const hasObs = grantees.includes(uids.obs)
    hasRose && hasObs && data.length === 2
      ? ok(`seth sees 2 disclosure events (tutor Rose + observer) for her family`)
      : bad(`disclosure events wrong: ${JSON.stringify(data.map((r) => ({ g: r.detail?.grantee_id, c: r.child_id })))}`)
  }
}

console.log(fails ? `\nB1: ${fails} FAIL` : '\nB1: ALL PASS')
process.exit(fails ? 1 : 0)
