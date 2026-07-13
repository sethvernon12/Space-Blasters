// ============================================================================
// RM-39 benchmark corpus + metrics (Phase 5 · 5f-a). The self-labeling corpus is INTERNAL-ONLY
// (service_role; never a family caller), AUDITED, and REFERENCE-NOT-COPY (derived live over
// confirmed handwriting grade Events + their uploads) — so purge_child removes a departed
// child's contributions for free. Plus the read-benchmark metrics (whole-number exact-match +
// confidence calibration). LOCAL only.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm39-benchmark-corpus-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY } from './family.mjs'
import { exactMatch, calibration, clearsBar } from '../../supabase/functions/_shared/grade-metrics.mjs'

let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha
const BRIELLE = A.children.brielle.childId

// ---------- metrics unit (pure) ----------
console.log('Unit: read-benchmark metrics…')
const em = exactMatch([{ read: 42, truth: 42 }, { read: 41, truth: 42 }, { read: null, truth: 7 }])
em.n === 3 && em.answered === 2 && em.correct === 1 && Math.abs(em.rate - 1 / 3) < 1e-9 && em.precision === 0.5
  ? ok('exactMatch: whole-number match; null reads count against coverage, not precision') : bad(`exactMatch: ${JSON.stringify(em)}`)
const cal = calibration([{ read: 42, truth: 42, confidence: 0.96 }, { read: 7, truth: 7, confidence: 0.95 }, { read: 41, truth: 42, confidence: 0.4 }])
const hi = cal.find((c) => c.lo === 0.9), lo = cal.find((c) => c.lo === 0)
hi.n === 2 && hi.exact_match === 1 && lo.n === 1 && lo.exact_match === 0
  ? ok('calibration: high-confidence band exact (2/2); the misread sits in the low band (0/1) → routable to human') : bad(`calibration: ${JSON.stringify(cal)}`)
const cleared = clearsBar(calibration([{ read: 1, truth: 1, confidence: 0.95 }, { read: 2, truth: 2, confidence: 0.95 }]))
const notCleared = clearsBar(calibration([{ read: 1, truth: 1, confidence: 0.95 }, { read: 9, truth: 2, confidence: 0.95 }]))
cleared.cleared === true && notCleared.cleared === false
  ? ok('clearsBar: a clean high-confidence band clears; a leaked high-confidence error does not') : bad(`clearsBar: ${JSON.stringify({ cleared, notCleared })}`)

// ---------- corpus (DB) ----------
console.log('Setup…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)
const seth = await signInAs(cfg, A.parent.email)

try {
  // ---- INTERNAL-ONLY: a family/authenticated caller cannot invoke it ----
  const famCall = await seth.client.rpc('benchmark_corpus', { p_limit: 100 })
  famCall.error ? ok('INTERNAL: benchmark_corpus is NOT callable by a family/authenticated user (revoked)') : bad(`family reached the corpus: ${JSON.stringify(famCall.data)}`)

  // ---- seed a CONFIRMED handwriting grade (upload + grade Event) for Brielle ----
  const up = (await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
                       values ($1::uuid,$2::uuid,'parent',$1::text||'/'||$3||'.jpg','image/jpeg',1000,true,'graded') returning id`, [BRIELLE, uids.seth, uuid()]))[0].id
  await q(`insert into public.events (kind, author_actor_id, subject_child_id, context_ref_kind, context_ref_id, payload)
           values ('grade',$1::uuid,$2::uuid,'upload',$3::uuid, jsonb_build_object('source','handwriting','verdict','correct','effective_read',42,'upload_id',$3::text,'skill_id','mult2'))`, [uids.seth, BRIELLE, up])

  // ---- service reads the labeled pair (reference-not-copy) ----
  const c1 = (await admin.rpc('benchmark_corpus', { p_limit: 100 })).data
  const pair = (c1?.pairs ?? []).find((p) => p.upload_id === up)
  c1?.ok && pair && pair.ground_truth_read === 42 && pair.skill_id === 'mult2' && pair.storage_path.startsWith(BRIELLE + '/')
    ? ok('service assembles the labeled (sanitized-image, ground-truth-read=42) pair from the confirmed grade') : bad(`corpus: ${JSON.stringify(pair)}`)

  // ---- AUDITED ----
  const audits = (await q(`select count(*)::int n from public.audit_log where action='benchmark.corpus.read' and created_at > now()-interval '2 minutes'`))[0].n
  audits >= 1 ? ok('every corpus read is AUDITED (aggregate count, no per-child PII)') : bad(`no audit: ${audits}`)

  // ---- REFERENCE-NOT-COPY: purge_child removes the contribution for free ----
  await q(`select public.purge_child($1,$2,$3)`, [BRIELLE, uids.seth, uids.seth])
  const c2 = (await admin.rpc('benchmark_corpus', { p_limit: 100 })).data
  const stillThere = (c2?.pairs ?? []).some((p) => p.upload_id === up)
  !stillThere
    ? ok('DELETION COVENANT: after purge_child the departed child’s pair is GONE from the corpus (the source Event + upload were deleted — reference-not-copy)') : bad('a deleted child’s pair survived in the corpus')
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-39 BENCHMARK CORPUS: ${fails} FAIL ===` : '\n=== RM-39 BENCHMARK CORPUS: ALL PASS (internal-only + audited; reference-not-copy; purge reach; exact-match + calibration metrics) ===')
process.exit(fails ? 1 : 0)
