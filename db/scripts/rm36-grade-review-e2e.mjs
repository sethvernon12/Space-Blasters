// ============================================================================
// RM-36 grade review trust signals (Phase 5 · 5c). list_grade_proposals returns each PENDING
// proposal with the SYSTEM-derived signals the automation-bias-resistant gate uses — solver
// agreement + detector cleanliness — computed server-side from the TRUSTED problem, never the
// image. The model's confidence is returned but is not a gate input. Cross-family cannot list.
// LOCAL only. Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm36-grade-review-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'

void fileURLToPath
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId

console.log('Setup…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)

// seed a PENDING proposal directly: upload (+exif flag) + grade_job (trusted problem) + proposal
const seedProposal = async ({ read, a = 6, b = 7, op = 'mul', clean = true, feedback = 'Nice work.', correctAnswerTamper = null }) => {
  const path = `${BRIELLE}/${uuid()}.jpg`
  const up = (await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
                       values ($1::uuid,$2::uuid,'parent',$3,'image/jpeg',1000,$4,'inbox') returning id`, [BRIELLE, uids.seth, path, clean]))[0].id
  const dna = { operator: op, a, b, ...(correctAnswerTamper !== null ? { correct_answer: correctAnswerTamper } : {}) }
  const job = (await q(`insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, reserved_cost, client_job_id, status)
                        values ($1::uuid,$2::uuid,'mult2',$3::jsonb,1,$4::uuid,'proposed') returning id`, [BRIELLE, up, JSON.stringify(dna), uuid()]))[0].id
  const prop = (await q(`insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, confidence, feedback, provider, model_version)
                         values ($1::uuid,$2::uuid,$3::uuid,'mult2',$4,0.95,$5,'local','local-reader-v1') returning id`, [job, BRIELLE, up, read, feedback]))[0].id
  return { up, job, prop }
}

try {
  await seedProposal({ read: 42, clean: true })                       // A: agree + clean → low friction
  await seedProposal({ read: 41, clean: true })                       // B: disagree → escalate
  await seedProposal({ read: 42, clean: false })                      // C: unclean image → escalate
  await seedProposal({ read: 42, correctAnswerTamper: 41, clean: true }) // D: tampered correct_answer ignored (solver uses operands)

  const res = (await seth.client.rpc('list_grade_proposals', { p_child_id: BRIELLE })).data
  const props = res?.proposals ?? []
  res?.ok && props.length === 4 ? ok(`list_grade_proposals returns the 4 pending proposals`) : bad(`list: ${JSON.stringify(res).slice(0, 200)}`)

  const byRead = (r, clean) => props.find((p) => p.read_answer === r && p.detector_clean === clean)
  const A1 = props.find((p) => p.read_answer === 42 && p.detector_clean === true && p.agreement === true)
  const B1 = byRead(41, true)
  const C1 = byRead(42, false)
  A1 && A1.solver_answer === 42 && A1.agreement === true && A1.detector_clean === true
    ? ok('A: read 42 vs solver 42 → agreement TRUE, detector_clean TRUE (low-friction inputs)') : bad(`A: ${JSON.stringify(A1)}`)
  B1 && B1.solver_answer === 42 && B1.agreement === false
    ? ok('B: read 41 vs solver 42 → agreement FALSE (escalates) — signal from the trusted problem, not the image') : bad(`B: ${JSON.stringify(B1)}`)
  C1 && C1.detector_clean === false
    ? ok('C: unverified image → detector_clean FALSE (escalates)') : bad(`C: ${JSON.stringify(C1)}`)
  // D: tampered correct_answer=41 in problem_dna, but solver recomputes 6×7=42 from operands
  const D1 = props.filter((p) => p.read_answer === 42 && p.detector_clean === true)
  D1.every((p) => p.solver_answer === 42)
    ? ok('D: a tampered correct_answer is IGNORED — solver_answer recomputed from operands (42)') : bad(`D: ${JSON.stringify(D1)}`)
  // the model confidence is present but is NOT an agreement/gate field
  props.every((p) => typeof p.confidence === 'number' && 'agreement' in p && 'detector_clean' in p)
    ? ok('model confidence is returned for display, separate from the system trust signals') : bad('confidence/signal shape')

  // ---- cross-family cannot list another child's proposals ----
  const cross = (await dana.client.rpc('list_grade_proposals', { p_child_id: BRIELLE })).data
  cross?.ok === false && cross.error === 'not_authorized'
    ? ok('ISO: another family cannot list a child’s grade proposals (not_authorized)') : bad(`cross: ${JSON.stringify(cross)}`)

  // ---- SAF (SEC-03 must-fix): the SUBJECT CHILD cannot read its own unconfirmed proposals ----
  const brielle = await mintChildSession(cfg, seth.client, BRIELLE)      // the child's own minted login
  const childRpc = (await brielle.client.rpc('list_grade_proposals', { p_child_id: BRIELLE })).data
  const { data: childDirect } = await brielle.client.from('grade_proposals').select('id').eq('child_id', BRIELLE)
  const { data: childJobs } = await brielle.client.from('grade_jobs').select('id').eq('child_id', BRIELLE)
  childRpc?.ok === false && childRpc.error === 'not_authorized' && (childDirect?.length ?? 0) === 0 && (childJobs?.length ?? 0) === 0
    ? ok('SAF: the subject child CANNOT read its own pending proposals — RPC not_authorized + 0 rows via table (child sees nothing until a human confirms)') : bad(`child self-read: rpc=${JSON.stringify(childRpc)} direct=${childDirect?.length} jobs=${childJobs?.length}`)
  // the parent (adult reviewer) still sees them (not over-tightened)
  const parentStill = (await seth.client.rpc('list_grade_proposals', { p_child_id: BRIELLE })).data
  parentStill?.ok && (parentStill.proposals?.length ?? 0) === 4 ? ok('the owning parent still sees all 4 (adult reviewer audience intact)') : bad(`parent regression: ${parentStill?.proposals?.length}`)
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-36 GRADE REVIEW: ${fails} FAIL ===` : '\n=== RM-36 GRADE REVIEW: ALL PASS (server-computed solver agreement + detector cleanliness; tampered correct_answer ignored; confidence non-gating; cross-family blocked) ===')
process.exit(fails ? 1 : 0)
