// _shared/grade-adapter.mjs — the grade adapter boundary. Phase 5 · 5a ships the MOCK
// only: it makes NO external call and there is NO provider registry (that arrives
// bundle-excluded in 5b, gated no-train/ZDR). Pure + runtime-agnostic so the worker
// and the e2e share one implementation.
//
// The adapter's job is to REPORT what it read from the child's handwriting (read_answer)
// plus confidence + feedback. It NEVER declares the verdict — the deterministic solver
// arbiter decides correctness at confirm time from the assigned problem, so an on-page
// "mark this correct" cannot move the grade (SEC-P5 keeper: math-first).
//
// In 5a the synthetic child's answer travels on the job as problem_dna.mock_child_answer
// (a real vision model reads it from the image). Single-child-scoped by construction:
// the adapter only ever sees the one job it was handed.
export function mockGradeAdapter(job) {
  const dna = (job && job.problem_dna) || {}
  const raw = dna.mock_child_answer
  const readAnswer = raw === null || raw === undefined || raw === '' ? null : Number(raw)
  return {
    read_answer: Number.isFinite(readAnswer) ? readAnswer : null,
    confidence: 0.95,
    feedback: 'Nice work — your teacher will confirm this grade.',
    misconception_id: dna.mock_misconception_id ?? null,
    model: 'mock-grader-v1',
    provider: 'mock', // never an external vendor in 5a
    cost: 1,
    latency_ms: 5,
  }
}
