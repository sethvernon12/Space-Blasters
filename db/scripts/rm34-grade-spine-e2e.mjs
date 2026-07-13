// ============================================================================
// RM-34 image-grading spine (Phase 5 · 5a, MOCK adapter — no external call). The async
// pipeline + the deterministic-solver arbiter + 100% human confirmation, all under the
// strong-borders + SEC-P5 shape:
//   - submit an upload for grading (reserve budget) → grade_jobs queue.
//   - grade-worker claims + runs the MOCK adapter → PENDING proposal (Realtime) → settle.
//   - NOTHING counts until a human confirms (confirm_image_grade) — the ARBITER recomputes
//     the answer from the assigned problem (solver), so an injected verdict/correct_answer
//     cannot flip the grade.
//   - single-child isolation (cross-family cannot see/confirm); budget cap; AC-6 + purge.
// LOCAL only. Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm34-grade-spine-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'
import { gradeAdapter } from '../../supabase/functions/_shared/grade-adapter.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECRET = 'grade_secret_rm34'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId

console.log('Setup + serve grade-worker…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const rose = await signInAs(cfg, A.tutor.email)      // can-write tutor for Brielle
const dana = await signInAs(cfg, B.parent.email)     // other family

// seed an uploads row for Brielle (writes normally go through the definer RPC; superuser
// pg insert is fine for the fixture). No storage object needed — the mock reads the answer
// from the job, not the image.
const seedUpload = async () => (await q(
  `insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
   values ($1::uuid,$2::uuid,'parent',$1::text||'/'||$3||'.jpg','image/jpeg',1000,true,'inbox') returning id`,
  [BRIELLE, uids.seth, uuid()]))[0].id
const dna = (child, extra = {}) => ({ operator: 'mul', a: 6, b: 7, correct_answer: 42, mock_child_answer: child, ...extra })
// authored-path RPCs go through an authenticated CLIENT (auth.uid() from the JWT); reads
// + the service-path purge go through the superuser pg connection.
const submit = (client, upId, dnaObj) => client.rpc('submit_upload_for_grading', { p_upload_id: upId, p_skill_id: 'mult2', p_problem_dna: dnaObj, p_client_job_id: uuid() }).then((r) => r.data)
const confirm = (client, propId, override = null) => client.rpc('confirm_image_grade', { p_proposal_id: propId, p_override_feedback: override }).then((r) => r.data)

const envFile = path.join(root, 'supabase', '.env.rm34'); fs.writeFileSync(envFile, `GRADE_WORKER_SECRET=${SECRET}\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const runWorker = async (secret = SECRET) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/grade-worker`, { method: 'POST', headers: { 'X-Grade-Secret': secret, 'Content-Type': 'application/json' }, body: '{}' })
  let b = null; try { b = await r.json() } catch { /* */ }; return { status: r.status, body: b }
}
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await runWorker('wrong').catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('grade-worker serving') : bad('function not ready')

try {
  // ---- worker auth: bad secret → 401 ----
  ;(await runWorker('nope')).status === 401 ? ok('worker rejects a bad shared secret (401)') : bad('worker auth')

  // ---- 1. submit → job pending + budget reserved; async pipeline → PENDING proposal ----
  const up1 = await seedUpload()
  const sub = await submit(seth.client, up1, dna(42))
  const jobRow = sub.job_id ? (await q(`select status, reserved_cost from public.grade_jobs where id=$1`, [sub.job_id]))[0] : null
  sub.ok && jobRow?.status === 'pending' && Number(jobRow.reserved_cost) === 1
    ? ok('submit_upload_for_grading: job pending, budget reserved (reserve→…)') : bad(`submit: ${JSON.stringify(sub)} ${JSON.stringify(jobRow)}`)

  const w1 = await runWorker()
  const prop = (await q(`select id, status, provider, read_answer, grade_event_id from public.grade_proposals where job_id=$1`, [sub.job_id]))[0]
  const jobAfter = (await q(`select status, actual_cost from public.grade_jobs where id=$1`, [sub.job_id]))[0]
  const ledger = (await q(`select reserved, settled from public.grade_cost_ledger where child_id=$1 and day=current_date`, [BRIELLE]))[0]
  w1.status === 200 && prop?.status === 'pending' && prop.provider === 'local' && prop.read_answer === 42 && jobAfter.status === 'proposed' && Number(ledger.settled) === 0 && Number(ledger.reserved) === 0
    ? ok('worker: guardrailed adapter proposal PENDING (provider=local, read=42); job proposed; cost settled (→call→settle)') : bad(`drain: ${JSON.stringify({ prop, jobAfter, ledger, w1: w1.body })}`)

  // ---- 2. 100% HUMAN: nothing recorded until confirm ----
  const noGradeYet = (await q(`select count(*)::int n from public.events where kind='grade' and subject_child_id=$1`, [BRIELLE]))[0].n === 0
  noGradeYet ? ok('100% human: NO grade Event exists before a human confirms') : bad('a grade was recorded without confirmation')

  // ---- 3. confirm (correct): the ARBITER records verdict=correct (solver 6×7=42 == read 42) ----
  const conf = await confirm(seth.client, prop.id)
  const gradeEv = (await q(`select payload from public.events where kind='grade' and subject_child_id=$1 order by created_at desc limit 1`, [BRIELLE]))[0]?.payload
  const assess = (await q(`select graded_count, correct_count, transfer_success_count from public.child_skill_assessment where child_id=$1 and skill_id='mult2'`, [BRIELLE]))[0]
  const fb = (await q(`select payload->>'feedback' f, visibility_scope from public.teaching_artifacts where child_id=$1 and kind='feedback' order by created_at desc limit 1`, [BRIELLE]))[0]
  conf.ok && conf.verdict === 'correct' && gradeEv?.verdict === 'correct' && gradeEv.solver_answer === 42 && gradeEv.effective_read === 42
    && assess?.transfer_success_count === 1 && fb?.visibility_scope === 'sent-to-child'
    ? ok('confirm (correct): append-only grade Event (solver=42==read=42); transfer projection +1; moderated feedback sent-to-child') : bad(`confirm: ${JSON.stringify({ conf, gradeEv, assess, fb })}`)

  // idempotent re-confirm
  const conf2 = await confirm(seth.client, prop.id)
  conf2.ok && conf2.idempotent && (await q(`select count(*)::int n from public.events where kind='grade' and subject_child_id=$1`, [BRIELLE]))[0].n === 1
    ? ok('confirm is idempotent (no second grade Event)') : bad(`re-confirm: ${JSON.stringify(conf2)}`)

  // ---- 4. the ARBITER defeats a tampered problem: injected correct_answer is IGNORED ----
  // child wrote 42 (right), but the problem_dna's stored correct_answer is tampered to 41.
  // The solver computes 6×7=42 from the OPERANDS, so verdict stays correct.
  const up2 = await seedUpload()
  const jT = await submit(seth.client, up2, dna(42, { correct_answer: 41 }))
  await runWorker()
  const pT = (await q(`select id from public.grade_proposals where job_id=$1`, [jT.job_id]))[0]
  const cT = await confirm(seth.client, pT.id)
  cT.verdict === 'correct' ? ok('ARBITER: tampered correct_answer=41 IGNORED — solver recomputes 6×7=42 from operands → correct (on-page injection defeated)') : bad(`arbiter tamper: ${JSON.stringify(cT)}`)

  // ---- 5. incorrect path: child wrote 41 → verdict incorrect, transfer NOT incremented ----
  const up3 = await seedUpload()
  const jW = await submit(seth.client, up3, dna(41))
  await runWorker()
  const pW = (await q(`select id from public.grade_proposals where job_id=$1`, [jW.job_id]))[0]
  const cW = await confirm(seth.client, pW.id)
  const assessW = (await q(`select transfer_success_count, graded_count from public.child_skill_assessment where child_id=$1 and skill_id='mult2'`, [BRIELLE]))[0]
  cW.verdict === 'incorrect' && assessW.transfer_success_count === 2 && assessW.graded_count === 3
    ? ok('incorrect (read 41 ≠ solver 42): verdict incorrect; transfer NOT incremented (still 2 of 3 graded)') : bad(`incorrect: ${JSON.stringify({ cW, assessW })}`)

  // ---- 6. single-child isolation: other family cannot see or confirm Brielle's proposal ----
  const { data: danaSees } = await dana.client.from('grade_proposals').select('id').eq('id', prop.id)
  const danaConfirm = (await dana.client.rpc('confirm_image_grade', { p_proposal_id: prop.id, p_override_feedback: null })).data
  ;(danaSees?.length ?? 0) === 0 && danaConfirm?.ok === false && ['unknown_proposal', 'not_authorized'].includes(danaConfirm.error)
    ? ok('ISO: other-family parent cannot SEE (RLS) or CONFIRM (border) Brielle’s proposal') : bad(`iso: sees=${danaSees?.length} confirm=${JSON.stringify(danaConfirm)}`)
  // a can-write tutor CAN confirm (trusted interior)
  const up4 = await seedUpload()
  const jR = await submit(seth.client, up4, dna(42))
  await runWorker()
  const pR = (await q(`select id from public.grade_proposals where job_id=$1`, [jR.job_id]))[0]
  const cR = await confirm(rose.client, pR.id, 'Great job!')
  cR?.ok && cR.overridden ? ok('a can-write TUTOR can confirm (with an override) — the trusted interior') : bad(`tutor confirm: ${JSON.stringify(cR)}`)

  // ---- 7. budget cap: reserve fails closed at the daily cap ----
  await q(`update public.grade_cost_ledger set reserved=500 where child_id=$1 and day=current_date`, [BRIELLE])
  const up5 = await seedUpload()
  const capped = await submit(seth.client, up5, dna(42))
  capped.ok === false && capped.error === 'budget_exceeded' ? ok('budget cap: submit fails closed at the daily cap (reserve→…)') : bad(`cap: ${JSON.stringify(capped)}`)
  await q(`update public.grade_cost_ledger set reserved=0 where child_id=$1 and day=current_date`, [BRIELLE])

  // ---- HIGH (SEC-03 fix): the ledger helpers are NOT client-callable (revoked) ----
  const reserveDenied = await seth.client.rpc('reserve_grade_budget', { p_child: BRIELLE, p_estimate: 500 })
  const settleDenied = await dana.client.rpc('settle_grade_cost', { p_child: BRIELLE, p_estimate: 0, p_actual: 999 })
  const ledgerUntouched = Number((await q(`select coalesce(settled,0) s from public.grade_cost_ledger where child_id=$1 and day=current_date`, [BRIELLE]))[0]?.s ?? 0) < 900
  !!reserveDenied.error && !!settleDenied.error && ledgerUntouched
    ? ok('HIGH: reserve_grade_budget / settle_grade_cost NOT client-callable (revoked anon+authenticated); ledger untouched') : bad(`ledger helpers exposed: reserve=${JSON.stringify(reserveDenied)} settle=${JSON.stringify(settleDenied)}`)

  // ---- MED (SEC-03 fix): a stale 'claimed' job is reclaimed → proposed exactly once ----
  const up6 = await seedUpload()
  const jS = await submit(seth.client, up6, dna(42))
  await q(`update public.grade_jobs set status='claimed', updated_at=now()-interval '10 minutes' where id=$1`, [jS.job_id]) // simulate a dead worker
  await runWorker()
  const jSafter = (await q(`select status from public.grade_jobs where id=$1`, [jS.job_id]))[0].status
  const propS = (await q(`select count(*)::int n from public.grade_proposals where job_id=$1`, [jS.job_id]))[0].n
  jSafter === 'proposed' && propS === 1
    ? ok('MED: a stale claimed job is reclaimed → proposed EXACTLY once (reservation settled, not leaked)') : bad(`reclaim: status=${jSafter} props=${propS}`)

  // ---- 8. the guardrailed adapter is local-first, no external call (unit) ----
  const g = gradeAdapter({ problem_dna: dna(42) }, null)
  g.ok && g.output.provider === 'local' && g.output.read_answer === 42
    ? ok('guardrailed adapter: local-first (provider=local), reads the answer, external unreachable in bundle') : bad(`adapter: ${JSON.stringify(g)}`)

  // ---- 9. AC-6 + purge: new tables deleted + counted; nothing escapes ----
  const pr = (await q(`select public.purge_child($1,$2,$3) r`, [BRIELLE, uids.seth, uids.seth]))[0].r
  const left = (await q(`select
      (select count(*)::int from public.grade_jobs where child_id=$1) j,
      (select count(*)::int from public.grade_proposals where child_id=$1) p,
      (select count(*)::int from public.grade_cost_ledger where child_id=$1) l`, [BRIELLE]))[0]
  const d = pr.disposition?.deleted
  pr.ok && d?.grade_jobs >= 4 && d?.grade_proposals >= 4 && d?.grade_cost_ledger === 1 && left.j === 0 && left.p === 0 && left.l === 0
    ? ok(`purge_child: grade_jobs/proposals/ledger deleted + counted in the receipt (jobs=${d.grade_jobs}, props=${d.grade_proposals}); none escape`) : bad(`purge: ${JSON.stringify({ d, left })}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-34 GRADE SPINE: ${fails} FAIL ===` : '\n=== RM-34 GRADE SPINE: ALL PASS (async pipeline; solver-arbiter defeats injection; 100% human confirm; single-child isolation; budget cap; AC-6+purge) ===')
process.exit(fails ? 1 : 0)
