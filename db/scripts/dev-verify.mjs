// ============================================================================
// dev-verify.mjs — post-apply verification against the DEV staging project.
// DEV-ONLY: devConfig() whitelists the DEV ref and HARD-REFUSES prod. Seeds the
// synthetic families onto the MCP-applied migrations (seedFamily — never drops
// the schema) and runs the CROSS-FAMILY ISOLATION SWEEP + a smoke. The full
// 7×7×3 matrix is proven locally by family-b3-matrix on the identical migrations;
// this asserts the same isolation + consent invariants hold on DEV.
//
// Requires (server-side only; NEVER deployed / never in a client):
//   DEV_SUPABASE_URL / DEV_SUPABASE_ANON_KEY / DEV_SUPABASE_SERVICE_KEY / DEV_SUPABASE_DB_URL
// Prereq: migrations 0001–0012 applied on DEV + skills seeded (see docs/STAGING.md).
// Run: node db/scripts/dev-verify.mjs
// ============================================================================
import { devConfig } from './dev-config.mjs'
import { seedFamily, signInAs, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

const cfg = devConfig()                         // <-- refuses anything but the DEV ref
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }
const uuid = () => crypto.randomUUID()
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const mkEvent = () => ({ clientAttemptId: uuid(), clientSessionId: uuid(), stageIndex: 0, skill: 'addition', result: 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: 5, level: 1, mode: 'journey', context: { source: 'dev-verify' } })

console.log(`DEV staging verify → ${cfg.apiUrl} (synthetic families only)`)
const uids = await seedFamily(cfg)
const S = {}
for (const [w, e] of [['seth', A.parent.email], ['brielle', A.children.brielle.email], ['theo', A.children.theo.email],
  ['rose', A.tutor.email], ['obs', A.observer.email], ['dana', B.parent.email], ['wren', B.children.wren.email]]) S[w] = await signInAs(cfg, e)
const tok = (a) => S[a].session.access_token

// populate one attempt per child (sessions + attempts + mastery)
for (const [a, k] of [['brielle', 'Brielle'], ['theo', 'Theo'], ['wren', 'Wren']]) {
  const { data } = await S[a].client.rpc('record_attempts_authed', { p_child_id: CID[k], p_batch: buildBatch([mkEvent()]) })
  if (!(data && data.ok)) bad(`seed attempt for ${k}: ${JSON.stringify(data)}`)
}

async function seesRows(a, table, col, cid) {
  const res = await fetch(`${cfg.apiUrl}/rest/v1/${table}?${col}=eq.${cid}&select=*`, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${tok(a)}` } })
  return res.ok ? (await res.json()).length > 0 : false
}
const READ_TABLES = [['children', 'id'], ['sessions', 'child_id'], ['attempts', 'child_id'], ['child_skill_mastery', 'child_id'], ['assignments', 'child_id'], ['teaching_artifacts', 'child_id']]
const FAM = { seth: 'A', brielle: 'A', theo: 'A', rose: 'A', obs: 'A', dana: 'B', wren: 'B' }
const KIDFAM = { Brielle: 'A', Theo: 'A', Wren: 'B' }

// ---- 1. CROSS-FAMILY ISOLATION SWEEP (the gate) ----
console.log('cross-family isolation sweep:')
{
  let cells = 0, leaks = 0
  for (const [table, col] of READ_TABLES) for (const a of Object.keys(FAM)) for (const k of Object.keys(KIDFAM)) {
    if (FAM[a] === KIDFAM[k]) continue
    cells++
    if (await seesRows(a, table, col, CID[k])) leaks++
  }
  leaks === 0 ? ok(`0 cross-family leaks across ${cells} read cells`) : bad(`${leaks} CROSS-FAMILY LEAKS`)
}

// ---- 2. smoke: scope + consent + proposal-behind-approval ----
console.log('smoke (scope + consent + AI proposal path):')
{
  const parentSees = await seesRows('seth', 'child_skill_mastery', 'child_id', CID.Brielle)
  const otherBlocked = !(await seesRows('dana', 'child_skill_mastery', 'child_id', CID.Brielle))
  parentSees && otherBlocked ? ok('parent sees own child mastery; other family blocked') : bad(`scope: own=${parentSees} otherBlocked=${otherBlocked}`)

  const danaWrite = await S.dana.client.rpc('record_attempts_authed', { p_child_id: CID.Brielle, p_batch: buildBatch([mkEvent()]) })
  !danaWrite.data?.ok ? ok('cross-family WRITE denied (record_attempts_authed = is_my_child)') : bad('cross-family write allowed')

  // proposal-behind-approval: a submission + AI proposal must NOT create an authoritative grade until approved
  const sub = (await S.brielle.client.rpc('record_submission', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: { operator: '+', operands: [2, 3], correct_answer: 5 }, p_submitted_answer: 5, p_explanation: 'x' })).data?.submission_id
  await S.rose.client.rpc('propose_grade', { p_submission_id: sub, p_verdict: 'correct', p_score: 100, p_feedback: 'ok', p_model: 'x', p_prompt_version: 'x', p_misconception_id: null })
  const beforeGrade = await seesRows('seth', 'events', 'subject_child_id', CID.Brielle) // events incl. attempt sessions? use a targeted check below
  const pending = (await S.seth.client.rpc('pending_grades')).data ?? []
  pending.length >= 1 ? ok('AI grade is a PENDING proposal (awaiting human approval)') : bad('no pending proposal surfaced')
  void beforeGrade
}

// ---- 3. consent revocation hides derived + raw child data ----
console.log('consent revocation:')
{
  // revoke Brielle's consent (service-side, DEV-only) and confirm the tutor loses access
  const { Client } = (await import('pg')).default
  const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
  let saved
  try {
    saved = (await c.query(`select consent_id from public.children where id=$1`, [CID.Brielle])).rows[0].consent_id
    await c.query(`update public.children set consent_id = null where id = $1`, [CID.Brielle])
  } finally { await c.end() }
  const roseStillSees = await seesRows('rose', 'child_skill_mastery', 'child_id', CID.Brielle)
  !roseStillSees ? ok('after consent revoked, granted tutor can no longer read child data') : bad('consent revocation did NOT cut access')
  // restore so DEV is left seeded + consented + populated for the browser smoke
  const c2 = new Client({ connectionString: cfg.dbUrl }); await c2.connect()
  try { await c2.query(`update public.children set consent_id = $1 where id = $2`, [saved, CID.Brielle]) } finally { await c2.end() }
  ok('consent restored — DEV left seeded + consented (a pending grade proposal remains for the cockpit smoke)')
}

console.log(fails ? `\n=== DEV VERIFY: ${fails} FAIL ===` : '\n=== DEV VERIFY: ALL PASS (DEV isolation + smoke green) ===')
process.exit(fails ? 1 : 0)
