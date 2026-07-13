// grade-worker — Phase 5 · 5a. Drains the grade_jobs queue with the MOCK adapter.
// Not user-facing: verify_jwt=false, authenticated by a SHARED SECRET header
// (fail-closed — no secret configured ⇒ reject everything), same doctrine as
// maintenance-worker / stripe-webhook. Intended to be invoked by pg_cron (pg_net) or
// a platform scheduler with X-Grade-Secret set.
//
// Each pass: claim pending jobs (SKIP LOCKED) → run the MOCK adapter (NO external call,
// NO provider registry — that arrives bundle-excluded in 5b) → record_grade_proposal
// (writes a PENDING proposal + settles the reserved cost; Realtime notifies the UI).
// A proposal is only that — nothing counts until a human confirms (confirm_image_grade).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { gradeAdapter } from '../_shared/grade-adapter.mjs'

const UPLOADS_BUCKET = 'uploads'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SECRET = Deno.env.get('GRADE_WORKER_SECRET') ?? ''
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 })
  // shared-secret auth, fail-closed + constant-ish time compare
  const given = req.headers.get('X-Grade-Secret') ?? ''
  if (!SECRET || given.length !== SECRET.length) return json({ error: 'unauthorized' }, 401)
  let diff = 0
  for (let i = 0; i < SECRET.length; i++) diff |= given.charCodeAt(i) ^ SECRET.charCodeAt(i)
  if (diff !== 0) return json({ error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const service = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const out: Record<string, unknown> = { proposed: 0, failed: 0 }

  try {
    const { data: claimed } = await service.rpc('claim_grade_jobs', { p_limit: Number(body?.limit ?? 20) })
    for (const job of (claimed ?? [])) {
      try {
        // fetch the upload object BYTES and hand them to the adapter INLINE — never a
        // fetchable URL to any external party (the local reader ignores them; the real
        // model at the gate reads from them). Best-effort: the local path works regardless.
        let bytes: Uint8Array | null = null
        if (job.storage_path) {
          const { data: blob } = await service.storage.from(UPLOADS_BUCKET).download(job.storage_path)
          if (blob) bytes = new Uint8Array(await blob.arrayBuffer())
        }
        const g = gradeAdapter(job, bytes) // guardrailed: local-first, external unreachable in bundle
        if (!g.ok) { await service.rpc('fail_grade_job', { p_job_id: job.id, p_error: g.error }); out.failed = (out.failed as number) + 1; continue }
        const o = g.output!
        const { data: rec } = await service.rpc('record_grade_proposal', {
          p_job_id: job.id, p_read_answer: o.read_answer, p_confidence: o.confidence, p_feedback: o.feedback,
          p_misconception_id: o.misconception_id, p_model: o.model, p_provider: o.provider, p_cost: o.cost, p_latency: o.latency_ms,
        })
        rec?.ok ? (out.proposed = (out.proposed as number) + 1) : await service.rpc('fail_grade_job', { p_job_id: job.id, p_error: rec?.error ?? 'record_failed' })
        if (!rec?.ok) out.failed = (out.failed as number) + 1
      } catch (e) {
        await service.rpc('fail_grade_job', { p_job_id: job.id, p_error: String((e as Error).message).slice(0, 200) })
        out.failed = (out.failed as number) + 1
      }
    }
  } catch (e) { out.error = String((e as Error).message) }

  return json({ ok: true, ...out })
})
