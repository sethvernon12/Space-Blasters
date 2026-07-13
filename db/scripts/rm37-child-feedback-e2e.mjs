// ============================================================================
// RM-37 child-facing feedback (Phase 5 · 5d). The subject child reads ONLY the human-
// moderated `sent-to-child` feedback (created on confirm) — NEVER a raw/unconfirmed AI
// proposal ('private' scope artifacts) and NEVER grade_proposals/grade_jobs (0031). SAF:
// the child sees nothing until a human confirms, then only the moderated note.
// LOCAL only. Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm37-child-feedback-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'

let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha
const BRIELLE = A.children.brielle.childId

console.log('Setup…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)

try {
  // seed: a moderated sent-to-child feedback (what the child SHOULD see)…
  await q(`insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, target_kind, target_id, visibility_scope)
           values ($1::uuid,$2::uuid,'parent','feedback','math','{"feedback":"Great job on your multiplication!"}'::jsonb,'upload',$3::uuid,'sent-to-child')`, [BRIELLE, uids.seth, uuid()])
  // …a PRIVATE unconfirmed AI proposal artifact (the child must NOT see it)…
  await q(`insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, target_kind, target_id, visibility_scope)
           values ($1::uuid,null,'ai','grade','math','{"feedback":"RAW UNCONFIRMED AI — for adults only","proposed":true}'::jsonb,'submission',$2::uuid,'private')`, [BRIELLE, uuid()])
  // …and a pending image-grade proposal (the child must NOT see it — 0031)
  const up = (await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
                       values ($1::uuid,$2::uuid,'parent',$1::text||'/'||$3||'.jpg','image/jpeg',1000,true,'inbox') returning id`, [BRIELLE, uids.seth, uuid()]))[0].id
  const job = (await q(`insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, reserved_cost, client_job_id, status)
                        values ($1::uuid,$2::uuid,'mult2','{"operator":"mul","a":6,"b":7}'::jsonb,1,$3::uuid,'proposed') returning id`, [BRIELLE, up, uuid()]))[0].id
  await q(`insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, confidence, feedback, provider, model_version)
           values ($1::uuid,$2::uuid,$3::uuid,'mult2',42,0.95,'raw ai feedback','local','local-reader-v1')`, [job, BRIELLE, up])

  // ---- the CHILD sees ONLY the sent-to-child note ----
  const brielle = await mintChildSession(cfg, seth.client, BRIELLE)
  const { data: childFb } = await brielle.client.from('teaching_artifacts').select('id,payload,visibility_scope').eq('child_id', BRIELLE).eq('kind', 'feedback').eq('visibility_scope', 'sent-to-child')
  const { data: childPrivate } = await brielle.client.from('teaching_artifacts').select('id').eq('child_id', BRIELLE).eq('visibility_scope', 'private')
  const { data: childProps } = await brielle.client.from('grade_proposals').select('id').eq('child_id', BRIELLE)
  ;(childFb?.length ?? 0) === 1 && childFb[0].payload.feedback === 'Great job on your multiplication!'
    ? ok('child sees its moderated sent-to-child note') : bad(`child feedback: ${JSON.stringify(childFb)}`)
  ;(childPrivate?.length ?? 0) === 0
    ? ok('SAF: child CANNOT see the private unconfirmed AI proposal (RLS 0006 excludes private)') : bad(`child saw private: ${JSON.stringify(childPrivate)}`)
  ;(childProps?.length ?? 0) === 0
    ? ok('SAF: child CANNOT see grade_proposals (0031 holds)') : bad(`child saw proposals: ${childProps?.length}`)

  // ---- the parent (adult) sees the note too (not over-tightened) ----
  const { data: parentFb } = await seth.client.from('teaching_artifacts').select('id').eq('child_id', BRIELLE).eq('kind', 'feedback').eq('visibility_scope', 'sent-to-child')
  ;(parentFb?.length ?? 0) === 1 ? ok('the parent also sees the sent-to-child note (regression)') : bad(`parent feedback: ${parentFb?.length}`)
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-37 CHILD FEEDBACK: ${fails} FAIL ===` : '\n=== RM-37 CHILD FEEDBACK: ALL PASS (child sees only the moderated sent-to-child note; never private proposals or grade_proposals) ===')
process.exit(fails ? 1 : 0)
