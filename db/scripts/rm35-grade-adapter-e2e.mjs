// ============================================================================
// RM-35 guardrailed grade adapter (Phase 5 · 5b). The provider registry BORDER (fail-closed,
// external unreachable in the dev bundle), local-first selection, strict output schema, the
// local-vs-external benchmark decision, INLINE image-byte transport, per-ACCOUNT cost cap +
// 80% spend alarm + submit rate-limit, and the corrected_read_answer transcript fix (raw AI
// read immutable, solver arbitrates the corrected value). Standing rule: names kept + seen,
// single-child-scoped, no crop/face/scrub.
// LOCAL only. Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm35-grade-adapter-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY } from './family.mjs'
import { assertCallable, selectProvider, isRegistered } from '../../supabase/functions/_shared/provider-registry.mjs'
import { gradeAdapter } from '../../supabase/functions/_shared/grade-adapter.mjs'
import { validateGradeOutput } from '../../supabase/functions/_shared/grade-schema.mjs'
import { benchmarkDecision } from '../../supabase/functions/_shared/grade-benchmark.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECRET = 'grade_secret_rm35'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha
const BRIELLE = A.children.brielle.childId, THEO = A.children.theo.childId

// ---------- PURE UNIT TESTS (the border, schema, benchmark — no DB) ----------
console.log('Unit: registry border / schema / benchmark…')
// registry: local callable; an unregistered external is fail-closed; adapter never calls external
!isRegistered('anthropic-vision') && assertCallable('local').ok && assertCallable('anthropic-vision').ok === false && assertCallable('anthropic-vision').reason === 'unregistered'
  ? ok('registry: local callable; unregistered external FAILS CLOSED') : bad('registry border')
selectProvider({ provider: 'anthropic-vision' }) === 'local' && selectProvider(undefined) === 'local'
  ? ok('selectProvider: an unavailable external falls back to LOCAL (never silently reaches out)') : bad('selectProvider fallback')
// the adapter, even told to use external, produces a LOCAL result — external is unreachable
const forced = gradeAdapter({ problem_dna: { operator: 'mul', a: 6, b: 7, local_read: 42 } }, null, { decision: { provider: 'anthropic-vision' } })
forced.ok && forced.output.provider === 'local' && forced.output.read_answer === 42
  ? ok('adapter: forced external decision still yields LOCAL (external unreachable in bundle)') : bad(`adapter forced-external: ${JSON.stringify(forced)}`)
// strict schema rejects malformed, accepts + projects valid (drops extra fields)
const badConf = validateGradeOutput({ read_answer: 5, confidence: 2, feedback: 'x', provider: 'local' })
const badRead = validateGradeOutput({ read_answer: 'nope', confidence: 0.5, feedback: 'x', provider: 'local' })
const good = validateGradeOutput({ read_answer: 5, confidence: 0.9, feedback: 'ok', provider: 'local', model: 'm', cost: 0, latency_ms: 3, EVIL: '<script>' })
!badConf.ok && !badRead.ok && good.ok && good.value.EVIL === undefined && good.value.read_answer === 5
  ? ok('schema: rejects bad confidence/read type; accepts valid + DROPS extra fields (whitelist)') : bad(`schema: ${JSON.stringify({ badConf, badRead, good })}`)
// benchmark: local-first
const dLocalMeets = benchmarkDecision({ provider: 'local', accuracy: 1.0 }, { provider: 'ext', accuracy: 0.99 })
const dExtBetter = benchmarkDecision({ provider: 'local', accuracy: 0.7 }, { provider: 'ext', accuracy: 0.98 })
const dExtNotBetter = benchmarkDecision({ provider: 'local', accuracy: 0.85 }, { provider: 'ext', accuracy: 0.86 })
dLocalMeets.provider === 'local' && dExtBetter.provider === 'ext' && dExtNotBetter.provider === 'local'
  ? ok('benchmark: local wins when it meets the bar; external only when MATERIALLY better + over bar') : bad(`benchmark: ${JSON.stringify({ dLocalMeets, dExtBetter, dExtNotBetter })}`)

// ---------- E2E (against the full stack + worker) ----------
console.log('Setup + serve grade-worker…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)
const seth = await signInAs(cfg, A.parent.email)
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(20).fill(0), 0xFF, 0xD9])
const seedUpload = async (child = BRIELLE, withObject = false) => {
  const name = `${child}/${uuid()}.jpg`
  if (withObject) { const { error } = await admin.storage.from('uploads').upload(name, JPEG, { contentType: 'image/jpeg', upsert: true }); if (error) throw new Error('upload: ' + error.message) }
  return (await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
                  values ($1::uuid,$2::uuid,'parent',$3,'image/jpeg',$4,true,'inbox') returning id`, [child, uids.seth, name, JPEG.length]))[0].id
}
const dna = (localRead, extra = {}) => ({ operator: 'mul', a: 6, b: 7, correct_answer: 42, local_read: localRead, ...extra })
// 5e: submit binds to a gradeable ASSIGNMENT (server derives the problem). Fixture creates one.
const submit = async (upId, dnaObj) => {
  const child = (await q(`select child_id from public.uploads where id=$1`, [upId]))[0].child_id
  const asg = (await q(`insert into public.assignments (child_id, assigned_by, skill_id, title, problem_dna) values ($1::uuid,$2::uuid,'mult2','grade fixture',$3::jsonb) returning id`, [child, uids.seth, JSON.stringify(dnaObj)]))[0].id
  return seth.client.rpc('submit_upload_for_grading', { p_upload_id: upId, p_assignment_id: asg, p_client_job_id: uuid() }).then((r) => r.data)
}
const confirm = (propId, { override = null, corrected = null } = {}) => seth.client.rpc('confirm_image_grade', { p_proposal_id: propId, p_override_feedback: override, p_corrected_read_answer: corrected }).then((r) => r.data)
const propFor = async (jobId) => (await q(`select id, read_answer, provider, status from public.grade_proposals where job_id=$1`, [jobId]))[0]
const resetLedger = (child) => q(`delete from public.grade_cost_ledger where child_id=$1`, [child])

const envFile = path.join(root, 'supabase', '.env.rm35'); fs.writeFileSync(envFile, `GRADE_WORKER_SECRET=${SECRET}\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const runWorker = async (secret = SECRET) => { const r = await fetch(`${cfg.apiUrl}/functions/v1/grade-worker`, { method: 'POST', headers: { 'X-Grade-Secret': secret, 'Content-Type': 'application/json' }, body: '{}' }); let b = null; try { b = await r.json() } catch { /* */ }; return { status: r.status, body: b } }
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await runWorker('wrong').catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('grade-worker serving') : bad('function not ready')

try {
  // ---- inline transport: a REAL upload object → worker downloads bytes → local proposal ----
  const upObj = await seedUpload(BRIELLE, true)
  const jObj = await submit(upObj, dna(42))
  await runWorker()
  const pObj = await propFor(jObj.job_id)
  pObj?.status === 'pending' && pObj.provider === 'local' && pObj.read_answer === 42
    ? ok('inline transport: worker fetched the object bytes + adapter produced a local proposal (no URL to any external party)') : bad(`inline: ${JSON.stringify(pObj)}`)

  // ---- corrected_read_answer: raw read WRONG (41), human corrects to 42 → solver says correct ----
  const upC = await seedUpload()
  const jC = await submit(upC, dna(41))            // local reads 41 (a misread); solver = 42
  await runWorker()
  const pC = await propFor(jC.job_id)
  const cC = await confirm(pC.id, { corrected: 42 })
  const ev = (await q(`select payload from public.events where kind='grade' and subject_child_id=$1 order by created_at desc limit 1`, [BRIELLE]))[0].payload
  const rawImmutable = (await q(`select read_answer, status from public.grade_proposals where id=$1`, [pC.id]))[0]
  cC.ok && cC.verdict === 'correct' && cC.corrected === true && ev.raw_read === 41 && ev.corrected_read === 42 && ev.effective_read === 42 && ev.solver_answer === 42
    && rawImmutable.read_answer === 41 && rawImmutable.status === 'overridden'
    ? ok('corrected_read: human fixes misread 41→42; solver arbitrates CORRECTED (correct); raw AI read stays immutable (41)') : bad(`corrected: ${JSON.stringify({ cC, ev, rawImmutable })}`)

  // an uncorrected confirm still uses the raw read (solver arbitrates raw)
  const upC2 = await seedUpload()
  const jC2 = await submit(upC2, dna(41))
  await runWorker()
  const pC2 = await propFor(jC2.job_id)
  const cC2 = await confirm(pC2.id, {})
  cC2.verdict === 'incorrect' && cC2.corrected === false ? ok('uncorrected confirm arbitrates the raw read (41 ≠ 42 → incorrect)') : bad(`uncorrected: ${JSON.stringify(cC2)}`)

  // ---- per-ACCOUNT cap aggregates across siblings ----
  await resetLedger(BRIELLE); await resetLedger(THEO)
  await q(`insert into public.grade_cost_ledger (child_id, day, settled) values ($1,current_date,2000) on conflict (child_id,day) do update set settled=2000`, [BRIELLE]) // account cap = 500*4 = 2000, now full
  const upT = await seedUpload(THEO)
  const capped = await submit(upT, dna(42))
  capped?.ok === false && capped.error === 'budget_exceeded'
    ? ok('per-account cap: a sibling (Brielle) at the account cap blocks Theo’s submit (aggregation across the family)') : bad(`account cap: ${JSON.stringify(capped)}`)

  // ---- spend alarm at 80% of the account cap ----
  await resetLedger(BRIELLE); await resetLedger(THEO)
  await q(`insert into public.grade_cost_ledger (child_id, day, settled) values ($1,current_date,1600) on conflict (child_id,day) do update set settled=1600`, [BRIELLE]) // 80% of 2000
  const upA = await seedUpload(THEO)
  const alarmSubmit = await submit(upA, dna(42))
  const alarmAudit = (await q(`select count(*)::int n from public.audit_log where action='grade.spend_alarm' and created_at > now()-interval '2 minutes'`))[0].n
  alarmSubmit?.ok && alarmAudit >= 1 ? ok('spend alarm: crossing 80% of the account cap fires an audited grade.spend_alarm (non-blocking)') : bad(`alarm: submit=${JSON.stringify(alarmSubmit)} audits=${alarmAudit}`)

  // ---- submit rate-limit ----
  await resetLedger(BRIELLE)
  let lastErr = null
  for (let i = 0; i < 11; i++) { const u = await seedUpload(); const r = await submit(u, dna(42)); if (r?.error) lastErr = r.error }
  lastErr === 'rate_limited' ? ok('rate-limit: >10 submits/min for one child are refused (rate_limited)') : bad(`rate-limit: lastErr=${lastErr}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-35 GRADE ADAPTER: ${fails} FAIL ===` : '\n=== RM-35 GRADE ADAPTER: ALL PASS (registry border fail-closed; local-first; strict schema; benchmark; inline transport; per-account cap + alarm + rate-limit; corrected_read solver-arbitrated, raw immutable) ===')
process.exit(fails ? 1 : 0)
