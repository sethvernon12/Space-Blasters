// Strict output-schema for a local reader's result (Phase 5 · 5f-b) — the browser mirror of the
// server-side grade-schema. A model's output is UNTRUSTED: parse to a whitelist projection and
// reject anything malformed/adversarial before it becomes a read_answer. The verdict is never
// taken from here (the deterministic solver decides); confidence is a routing signal only.
export interface ReaderOutput { read_answer: number | null; confidence: number; provider: string; model: string }

export function validateReaderOutput(o: unknown): { ok: true; value: ReaderOutput } | { ok: false; reason: string } {
  if (o == null || typeof o !== 'object') return { ok: false, reason: 'not_object' }
  const r = o as Record<string, unknown>
  const ra = r.read_answer
  if (!(ra === null || (typeof ra === 'number' && Number.isInteger(ra)))) return { ok: false, reason: 'read_answer_type' }
  const c = r.confidence
  if (!(typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1)) return { ok: false, reason: 'confidence_range' }
  if (typeof r.provider !== 'string' || r.provider.length > 32) return { ok: false, reason: 'provider' }
  return { ok: true, value: { read_answer: ra as number | null, confidence: c, provider: r.provider, model: String(r.model ?? '').slice(0, 64) } }
}
