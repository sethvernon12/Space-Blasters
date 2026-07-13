// ============================================================================
// RM-38 assignment binding (Phase 5 · 5e). A graded problem is DERIVED server-side from a
// real assignment — the client no longer supplies a problem. A cross-family, not-this-child,
// problem-less, or unknown binding FAILS CLOSED. The solver arbitrates from that trusted
// problem, never the image. Closes the 5b-review LOW (problem_dna was free-form caller input).
// LOCAL only. Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm38-assignment-binding-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId, THEO = A.children.theo.childId, WREN = B.children.wren.childId

console.log('Setup…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const rose = await signInAs(cfg, A.tutor.email)

const seedUpload = async (child) => (await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
  values ($1::uuid,$2::uuid,'parent',$1::text||'/'||$3||'.jpg','image/jpeg',1000,true,'inbox') returning id`, [child, uids.seth, uuid()]))[0].id
const seedAssignment = async (child, by, problem) => (await q(`insert into public.assignments (child_id, assigned_by, skill_id, title, problem_dna)
  values ($1::uuid,$2::uuid,'mult2','Assignment',$3) returning id`, [child, by, problem === null ? null : JSON.stringify(problem)]))[0].id
const submit = (client, upId, asgId) => client.rpc('submit_upload_for_grading', { p_upload_id: upId, p_assignment_id: asgId, p_client_job_id: uuid() }).then((r) => r.data)

try {
  const upB = await seedUpload(BRIELLE)
  const asgB = await seedAssignment(BRIELLE, uids.seth, { operator: 'mul', a: 6, b: 7, local_read: 42 })
  const asgTheo = await seedAssignment(THEO, uids.seth, { operator: 'add', a: 1, b: 1 })
  const asgWren = await seedAssignment(WREN, uids.dana, { operator: 'mul', a: 2, b: 2 })   // other family
  const asgNoProblem = await seedAssignment(BRIELLE, uids.seth, null)

  // ---- valid: the problem is DERIVED from the assignment (not client-supplied) ----
  const good = await submit(seth.client, upB, asgB)
  const job = good.job_id ? (await q(`select skill_id, problem_dna from public.grade_jobs where id=$1`, [good.job_id]))[0] : null
  good.ok && job && job.skill_id === 'mult2' && job.problem_dna.a === 6 && job.problem_dna.b === 7 && job.problem_dna.operator === 'mul'
    ? ok('valid: submit derives skill + problem from the assignment (6×7); no client problem param exists') : bad(`valid: ${JSON.stringify({ good, job })}`)
  // a can-write tutor can bind too
  const upB2 = await seedUpload(BRIELLE)
  const tutorGood = await submit(rose.client, upB2, asgB)
  tutorGood.ok ? ok('a can-write tutor can grade against the assignment') : bad(`tutor: ${JSON.stringify(tutorGood)}`)

  // ---- fail closed: unknown assignment ----
  const unk = await submit(seth.client, await seedUpload(BRIELLE), uuid())
  unk.ok === false && unk.error === 'unknown_assignment' ? ok('fail-closed: unknown assignment → unknown_assignment') : bad(`unknown: ${JSON.stringify(unk)}`)

  // ---- fail closed: NOT-this-child (a sibling's assignment against Brielle's page) ----
  const mism = await submit(seth.client, await seedUpload(BRIELLE), asgTheo)
  mism.ok === false && mism.error === 'binding_mismatch' ? ok('fail-closed: a sibling’s assignment on this child’s page → binding_mismatch') : bad(`not-this-child: ${JSON.stringify(mism)}`)

  // ---- fail closed: CROSS-FAMILY (another family's assignment) ----
  const cross = await submit(seth.client, await seedUpload(BRIELLE), asgWren)
  cross.ok === false && cross.error === 'binding_mismatch' ? ok('fail-closed: another family’s assignment → binding_mismatch (no leak of its details)') : bad(`cross-family: ${JSON.stringify(cross)}`)

  // ---- fail closed: PROBLEM-LESS assignment ----
  const noprob = await submit(seth.client, await seedUpload(BRIELLE), asgNoProblem)
  noprob.ok === false && noprob.error === 'no_problem' ? ok('fail-closed: a problem-less assignment → no_problem') : bad(`no-problem: ${JSON.stringify(noprob)}`)

  // ---- the OLD signature (client-supplied problem) is GONE ----
  const legacy = await seth.client.rpc('submit_upload_for_grading', { p_upload_id: upB, p_skill_id: 'mult2', p_problem_dna: { operator: 'mul', a: 9, b: 9 }, p_client_job_id: uuid() })
  legacy.error ? ok('the old client-supplied-problem signature no longer exists (a tampered problem cannot be submitted)') : bad(`legacy sig still callable: ${JSON.stringify(legacy.data)}`)

  // ---- SEC-03 LOW fix: grade_solve is TOTAL (a malformed/overflowing problem → null, never a throw) ----
  const solve = async (dna) => (await q(`select public.grade_solve($1::jsonb) v`, [JSON.stringify(dna)]))[0].v
  const sValid = await solve({ operator: 'mul', a: 6, b: 7 })
  const sBadOperand = await solve({ operator: 'mul', a: 'abc', b: 7 })
  const sOverflow = await solve({ operator: 'mul', a: 999999999, b: 999999999 })
  const sDivZero = await solve({ operator: 'div', a: 5, b: 0 })
  sValid === 42 && sBadOperand === null && sOverflow === null && sDivZero === null
    ? ok('grade_solve is total: valid=42; non-numeric/overflow/div-0 all → null (no throw → no confirm abort)') : bad(`grade_solve: ${JSON.stringify({ sValid, sBadOperand, sOverflow, sDivZero })}`)
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-38 ASSIGNMENT BINDING: ${fails} FAIL ===` : '\n=== RM-38 ASSIGNMENT BINDING: ALL PASS (server-derived problem; unknown/not-this-child/cross-family/problem-less all fail closed; old client-problem signature gone) ===')
process.exit(fails ? 1 : 0)
