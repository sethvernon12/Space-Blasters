// _shared/grade-schema.mjs — strict output-schema validation for a grade adapter's result.
// Phase 5 · 5b. Pure. A model's output is UNTRUSTED: parse it to a whitelist projection,
// reject anything malformed/oversized BEFORE it is stored or shown. Injection hygiene, not
// privacy (the verdict is never taken from here — the solver arbiter decides). Render-time
// HTML escaping of feedback is 5c's job.
export function validateGradeOutput(o) {
  if (o == null || typeof o !== 'object') return { ok: false, reason: 'not_object' }
  const ra = o.read_answer
  if (!(ra === null || Number.isInteger(ra))) return { ok: false, reason: 'read_answer_type' }
  const conf = o.confidence
  if (!(typeof conf === 'number' && conf >= 0 && conf <= 1)) return { ok: false, reason: 'confidence_range' }
  if (typeof o.feedback !== 'string' || o.feedback.length > 2000) return { ok: false, reason: 'feedback' }
  if (!(o.misconception_id === null || o.misconception_id === undefined || typeof o.misconception_id === 'string')) return { ok: false, reason: 'misconception' }
  if (typeof o.provider !== 'string' || o.provider.length > 64) return { ok: false, reason: 'provider' }
  // whitelist projection — any extra fields are dropped
  return {
    ok: true,
    value: {
      read_answer: ra,
      confidence: conf,
      feedback: o.feedback,
      misconception_id: o.misconception_id ?? null,
      provider: o.provider,
      model: String(o.model ?? '').slice(0, 64),
      cost: Number.isFinite(o.cost) ? Number(o.cost) : 0,
      latency_ms: Number.isFinite(o.latency_ms) ? Number(o.latency_ms) : 0,
    },
  }
}
