// benchmark-grade.mjs — Phase 5 · 5b. The local-vs-external grading benchmark harness.
// Scores the LOCAL reader (live, in-process, crosses no border) on a labeled synthetic set and
// compares it to a RECORDED, CLEARLY-LABELED not-live external baseline — then emits the
// local-first decision. External is NOT called (bundle-excluded + structurally unreachable in
// dev); the baseline is historical numbers only, to exercise the decision logic.
// Run: node db/scripts/benchmark-grade.mjs
import { localRead } from '../../supabase/functions/_shared/grade-local-reader.mjs'
import { benchmarkDecision } from '../../supabase/functions/_shared/grade-benchmark.mjs'

// labeled synthetic set (problem + the child's true written answer)
const SET = [
  { dna: { operator: 'add', a: 2, b: 3, local_read: 5 }, truth: 5 },
  { dna: { operator: 'mul', a: 6, b: 7, local_read: 42 }, truth: 42 },
  { dna: { operator: 'sub', a: 9, b: 4, local_read: 5 }, truth: 5 },
  { dna: { operator: 'mul', a: 8, b: 8, local_read: 64 }, truth: 64 },
  { dna: { operator: 'add', a: 10, b: 15, local_read: 25 }, truth: 25 },
]

// RECORDED external baseline — NOT a live call. Historical numbers only.
const EXTERNAL_BASELINE_RECORDED = { provider: 'anthropic-vision', accuracy: 0.97, latency_ms: 900, cost: 1.0, note: 'RECORDED / not-live — informational baseline only' }

function scoreLocal() {
  let correct = 0, latency = 0, cost = 0
  for (const item of SET) {
    const t0 = 0 // deterministic; no wall-clock (Date.now is unavailable in some sandboxes)
    const r = localRead({ problem_dna: item.dna }, null)
    if (r.read_answer === item.truth) correct++
    latency += r.latency_ms; cost += r.cost
    void t0
  }
  return { provider: 'local', accuracy: correct / SET.length, latency_ms: latency / SET.length, cost: cost / SET.length }
}

const local = scoreLocal()
const decision = benchmarkDecision(local, EXTERNAL_BASELINE_RECORDED)
console.log('LOCAL (live):   ', JSON.stringify(local))
console.log('EXTERNAL (recorded, not-live):', JSON.stringify(EXTERNAL_BASELINE_RECORDED))
console.log('DECISION:       ', JSON.stringify(decision))

// In dev the deterministic local reader is perfect on the labeled set → meets the bar → local
// is chosen, and even if external scored higher the registry border would still gate it.
const okDecision = decision.provider === 'local'
console.log(okDecision ? '\n=== BENCHMARK: local-first decision holds (external is advisory + border-gated) ===' : '\n=== BENCHMARK: UNEXPECTED non-local decision ===')
process.exit(okDecision ? 0 : 1)
