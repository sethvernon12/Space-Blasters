// _shared/grade-local-reader.mjs — the deterministic LOCAL reader. Phase 5 · 5b. This is the
// dev-harness SEAM for the real local vision model dropped in at the real-family gate. It
// crosses NO border (in-process, no network, cost 0).
//
// It REPORTS what it read (read_answer) + confidence + feedback — it NEVER declares the
// verdict (the deterministic solver arbiter decides at confirm from the assigned problem).
// In dev it reads a controllable value carried on the job; the real local model reads it from
// the inline image bytes (which it is handed but the dev stand-in ignores).
export function localRead(job, _imageBytes) {
  const dna = (job && job.problem_dna) || {}
  const raw = dna.local_read ?? dna.mock_child_answer // dev stand-in; real OCR uses _imageBytes
  const readAnswer = raw === null || raw === undefined || raw === '' ? null : Number(raw)
  return {
    read_answer: Number.isFinite(readAnswer) ? readAnswer : null,
    confidence: 0.95,
    feedback: 'Nice work — your teacher will confirm this grade.',
    misconception_id: dna.mock_misconception_id ?? null,
    provider: 'local',
    model: 'local-reader-v1',
    cost: 0, // local crosses no border and spends nothing
    latency_ms: 3,
  }
}
