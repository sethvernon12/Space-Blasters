// ============================================================================
// B3 — the FORMAL family-isolation matrix (milestone gate). Two families + a
// teaching tutor + a view-only observer + revocation. Sweeps EVERY child-scoped
// table × all 7 actors × 3 children for both READ and WRITE, through the real
// client path (anon key + each role's JWT, RLS enforced). Proves one family can
// NEVER see or write another's data, a tutor is scoped to granted children, and
// revocation cuts access everywhere. Service key is seed/test-only.
//
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/family-b3-matrix.mjs
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
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }
const KIDS = ['Brielle', 'Theo', 'Wren']
const ACTORS = ['seth', 'brielle', 'theo', 'rose', 'obs', 'dana', 'wren']
const FAM = { seth: 'A', brielle: 'A', theo: 'A', rose: 'A', obs: 'A', dana: 'B', wren: 'B' }
const KIDFAM = { Brielle: 'A', Theo: 'A', Wren: 'B' }

// relationship truth (mutable grants, for revocation)
const parentKids = { seth: ['Brielle', 'Theo'], dana: ['Wren'] }
const childSelf = { brielle: 'Brielle', theo: 'Theo', wren: 'Wren' }
let viewGrant = { rose: ['Brielle'], obs: ['Brielle'] }
let writeGrant = { rose: ['Brielle'] }
const canParent = (a, k) => (parentKids[a] || []).includes(k)
const canOwn = (a, k) => canParent(a, k) || childSelf[a] === k          // is_my_child
const canView = (a, k) => canOwn(a, k) || (viewGrant[a] || []).includes(k)   // can_view_child
const canWrite = (a, k) => canOwn(a, k) || (writeGrant[a] || []).includes(k) // can_write_child
const isChild = (a) => !!childSelf[a]
// 0014: the adder-of-record must be an ADULT — a child identity can't author a
// teaching_artifact as parent/tutor, even for their own child row.
const canWriteAdult = (a, k) => canWrite(a, k) && !isChild(a)

console.log('Setting up two families + populating every table…')
const uids = await setupFamily(cfg)
const S = {}
for (const a of ACTORS) {
  const email = a === 'seth' ? A.parent.email : a === 'rose' ? A.tutor.email : a === 'obs' ? A.observer.email
    : a === 'brielle' ? A.children.brielle.email : a === 'theo' ? A.children.theo.email
    : a === 'dana' ? B.parent.email : B.children.wren.email
  S[a] = await signInAs(cfg, email)
}
const tok = (a) => S[a].session.access_token
const mkEvent = () => ({ clientAttemptId: uuid(), clientSessionId: uuid(), stageIndex: 0, skill: 'addition', result: 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: 5, level: 1, mode: 'journey', context: { source: 'b3' } })

// ---- populate: each child has rows in every read table ----
for (const [a, k] of [['brielle', 'Brielle'], ['theo', 'Theo'], ['wren', 'Wren']]) {
  await S[a].client.rpc('record_attempts_authed', { p_child_id: CID[k], p_batch: buildBatch([mkEvent()]) }) // sessions+attempts+mastery
}
{
  const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
  try {
    for (const k of KIDS) await c.query(
      `insert into public.child_skill_misconception (child_id, skill_id, misconception_id, evidence_count, active) values ($1,'add5','adds-instead',2,true)`, [CID[k]])
  } finally { await c.end() }
}
// submissions (child self-records via RPC) + assessment (projection, pg-seeded) per child — so the sweep has rows
for (const [a, k] of [['brielle', 'Brielle'], ['theo', 'Theo'], ['wren', 'Wren']]) {
  await S[a].client.rpc('record_submission', { p_child_id: CID[k], p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: { operator: '+', operands: [2, 3], correct_answer: 5 }, p_submitted_answer: 5, p_explanation: 'x' })
}
{
  const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
  try {
    for (const k of KIDS) await c.query(
      `insert into public.child_skill_assessment (child_id, skill_id, graded_count, correct_count, transfer_success_count) values ($1,'add5',1,1,1)`, [CID[k]])
  } finally { await c.end() }
}
await S.seth.client.from('assignments').insert([
  { child_id: CID.Brielle, assigned_by: uids.seth, skill_id: 'add5', title: 'a' },
  { child_id: CID.Theo, assigned_by: uids.seth, skill_id: 'add5', title: 'a' }])
await S.dana.client.from('assignments').insert({ child_id: CID.Wren, assigned_by: uids.dana, skill_id: 'add5', title: 'a' })
// visibility_scope: 'family' so every can_view_child viewer sees them (the read
// matrix tests can_view_child; default-private scoping is proven in secure-yard-test).
await S.seth.client.from('teaching_artifacts').insert([
  { child_id: CID.Brielle, author_id: uids.seth, author_role: 'parent', kind: 'feedback', payload: {}, visibility_scope: 'family' },
  { child_id: CID.Theo, author_id: uids.seth, author_role: 'parent', kind: 'feedback', payload: {}, visibility_scope: 'family' }])
await S.dana.client.from('teaching_artifacts').insert({ child_id: CID.Wren, author_id: uids.dana, author_role: 'parent', kind: 'feedback', payload: {}, visibility_scope: 'family' })
await S.rose.client.from('teaching_artifacts').insert({ child_id: CID.Brielle, author_id: uids.rose, author_role: 'tutor', kind: 'grade', payload: {}, visibility_scope: 'family' })

// ---- probes (real client path) ----
async function seesRows(a, table, col, cid) {
  const res = await fetch(`${cfg.apiUrl}/rest/v1/${table}?${col}=eq.${cid}&select=*`, {
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${tok(a)}` } })
  if (!res.ok) return false
  return (await res.json()).length > 0
}
const READ_TABLES = [['children', 'id'], ['sessions', 'child_id'], ['attempts', 'child_id'],
  ['child_skill_mastery', 'child_id'], ['child_skill_misconception', 'child_id'],
  ['assignments', 'child_id'], ['teaching_artifacts', 'child_id'],
  ['submissions', 'child_id'], ['child_skill_assessment', 'child_id']]

async function writeAttempts(a, cid) {
  const { data } = await S[a].client.rpc('record_attempts_authed', { p_child_id: cid, p_batch: buildBatch([mkEvent()]) })
  return !!(data && data.ok && data.inserted === 1)
}
async function writeAssign(a, cid) {
  const { data, error } = await S[a].client.from('assignments').insert({ child_id: cid, assigned_by: uids[a], skill_id: 'add5', title: 'm' }).select()
  return !error && data?.length === 1
}
async function writeTeach(a, k, cid) {
  const role = canOwn(a, k) ? 'parent' : 'tutor'
  const { data, error } = await S[a].client.from('teaching_artifacts').insert({ child_id: cid, author_id: uids[a], author_role: role, kind: 'feedback', payload: {} }).select()
  return !error && data?.length === 1
}
async function writeRename(a, cid) {
  const { data, error } = await S[a].client.from('children').update({ nickname: 'Renamed' }).eq('id', cid).select()
  return !error && data?.length === 1
}

// matrix runner: check ALL actor×kid cells against a predicate
async function matrix(label, predicate, probe) {
  const miss = []
  for (const a of ACTORS) for (const k of KIDS) {
    const want = predicate(a, k), got = await probe(a, k)
    if (want !== got) miss.push(`${a}->${k} want=${want} got=${got}`)
  }
  miss.length ? bad(`${label}: ${miss.length}/${ACTORS.length * KIDS.length} WRONG — ${miss.slice(0, 6).join('; ')}`)
    : ok(`${label}: all ${ACTORS.length * KIDS.length} cells correct`)
}

async function runReadMatrices(tag) {
  console.log(`${tag} READ matrices (can_view_child):`)
  for (const [table, col] of READ_TABLES) await matrix(`READ ${table}`, canView, (a, k) => seesRows(a, table, col, CID[k]))
}
async function runWriteMatrices(tag) {
  console.log(`${tag} WRITE matrices:`)
  await matrix('WRITE attempts (record_attempts_authed = is_my_child)', canOwn, (a, k) => writeAttempts(a, CID[k]))
  await matrix('WRITE assignments (can_write_child)', canWrite, (a, k) => writeAssign(a, CID[k]))
  await matrix('WRITE teaching_artifacts (adult writer only — 0014, child self denied)', canWriteAdult, (a, k) => writeTeach(a, k, CID[k]))
  await matrix('UPDATE children nickname (parent only)', canParent, (a, k) => writeRename(a, CID[k]))
}

await runReadMatrices('①')
await runWriteMatrices('①')

// ---- bespoke tables: consent_ledger (parent-own) + tutor_grants (grantor/grantee) ----
console.log('bespoke-policy tables:')
await matrix('READ consent_ledger (parent sees only own child rows)', canParent, (a, k) => seesRows(a, 'consent_ledger', 'child_id', CID[k]))
{
  // tutor_grants for Brielle: visible to granting parent (seth) + grantees (rose, obs); nobody else
  const seeGrants = { seth: ['Brielle'], rose: ['Brielle'], obs: ['Brielle'] }
  await matrix('READ tutor_grants (grantor + grantees only)',
    (a, k) => (seeGrants[a] || []).includes(k),
    (a, k) => seesRows(a, 'tutor_grants', 'child_id', CID[k]))
}

// ---- always-blocked write paths: if the OWNER parent can't, nobody can ----
console.log('no client write path (probed as the owner parent):')
async function blocked(desc, fn) {
  try { const { data, error } = await fn(); (error || !data?.length) ? ok(desc) : bad(`${desc} — NOT blocked`) }
  catch { ok(desc) }
}
const M = S.seth.client, cidB = CID.Brielle
await blocked('INSERT attempts direct → blocked (RPC-only)', () => M.from('attempts').insert({ child_id: cidB, skill_id: 'add5', client_attempt_id: uuid(), result: 'correct' }).select())
await blocked('INSERT sessions direct → blocked', () => M.from('sessions').insert({ child_id: cidB, client_session_id: uuid() }).select())
await blocked('INSERT child_skill_mastery → blocked', () => M.from('child_skill_mastery').insert({ child_id: cidB, skill_id: 'add5', alpha: 9, beta: 1 }).select())
await blocked('INSERT child_skill_misconception → blocked', () => M.from('child_skill_misconception').insert({ child_id: cidB, skill_id: 'add5', misconception_id: 'x' }).select())
await blocked('INSERT submissions direct → blocked (RPC-only)', () => M.from('submissions').insert({ child_id: cidB, skill_id: 'add5', client_submission_id: uuid(), submitted_answer: 5 }).select())
await blocked('INSERT child_skill_assessment → blocked (definer-only)', () => M.from('child_skill_assessment').insert({ child_id: cidB, skill_id: 'add5', graded_count: 1 }).select())
await blocked('INSERT consent_ledger → blocked (service-only)', () => M.from('consent_ledger').insert({ parent_id: uids.seth, child_id: cidB, action: 'grant', method: 'other_vpc', policy_version: 'x' }).select())
await blocked('UPDATE attempts → blocked (append-only)', () => M.from('attempts').update({ result: 'incorrect' }).eq('child_id', cidB).select())
await blocked('DELETE attempts → blocked (append-only)', () => M.from('attempts').delete().eq('child_id', cidB).select())
await blocked('UPDATE teaching_artifacts → blocked (immutable)', () => M.from('teaching_artifacts').update({ payload: { x: 1 } }).eq('child_id', cidB).select())
await blocked('DELETE consent_ledger → blocked (immutable)', () => M.from('consent_ledger').delete().eq('child_id', cidB).select())

// ---- REVOCATION: cut Rose's grant, re-run EVERY matrix (rose→Brielle now all false) ----
console.log('REVOCATION — Seth revokes Rose; re-run every matrix:')
await S.seth.client.from('tutor_grants').update({ active: false }).eq('tutor_id', uids.rose).eq('child_id', CID.Brielle)
viewGrant = { obs: ['Brielle'] }   // rose removed; observer remains
writeGrant = {}                    // rose was the only can_write grant
await runReadMatrices('②(post-revoke)')
await runWriteMatrices('②(post-revoke)')

// ---- explicit cross-family leak counter ----
console.log('cross-family leak sweep:')
{
  let cells = 0, leaks = 0
  for (const [table, col] of READ_TABLES) for (const a of ACTORS) for (const k of KIDS) {
    if (FAM[a] === KIDFAM[k]) continue
    cells++
    if (await seesRows(a, table, col, CID[k])) leaks++
  }
  leaks === 0 ? ok(`0 cross-family leaks across ${cells} read cells (7 tables × cross pairs)`) : bad(`${leaks} CROSS-FAMILY LEAKS`)
}

console.log(fails ? `\n=== B3 MATRIX: ${fails} FAIL ===` : '\n=== B3 MATRIX: ALL PASS (isolation gate green) ===')
process.exit(fails ? 1 : 0)
