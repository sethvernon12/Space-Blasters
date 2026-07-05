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
  ['maya', A.parent.email], ['rose', A.tutor.email],
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
  ['maya (parent A)', S.maya, ['Brielle', 'Theo']],
  ['brielle (child)', S.brielle, ['Brielle']],
  ['theo (child)', S.theo, ['Theo']],
  ['rose (tutor→Brielle)', S.rose, ['Brielle']],
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
  const r = await writeAs(S.maya.client, CID.brielle)
  r.data?.ok && r.data.inserted === 1 ? ok('maya (parent) records for Brielle → inserted 1') : bad(`maya→brielle: ${JSON.stringify(r.data || r.error?.message)}`)
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
  const { data, error } = await assign(S.maya.client, CID.theo, uids.maya)
  !error && data?.length === 1 ? ok('maya (parent) assigns for her own Theo → created') : bad(`maya→Theo assign failed: ${error?.message}`)
}

console.log(fails ? `\nB1: ${fails} FAIL` : '\nB1: ALL PASS')
process.exit(fails ? 1 : 0)
