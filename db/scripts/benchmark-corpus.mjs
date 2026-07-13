// benchmark-corpus.mjs — Phase 5 · 5f-a. The read-benchmark harness. Assembles the labeled
// corpus — the REAL self-generated set (benchmark_corpus, internal/service-only) PLUS a PUBLIC
// handwritten-digit SEED to derisk the pipeline now — and scores a candidate reader with
// WHOLE-NUMBER exact-match + confidence CALIBRATION. 5f-a runs a MOCK candidate to prove the
// measurement pipeline; 5f-b feeds the real sanitized images to TrOCR-small / the CNN digit
// classifier through this harness. Run: eval "$(supabase status -o env)"; node db/scripts/benchmark-corpus.mjs
import { exactMatch, calibration, clearsBar } from '../../supabase/functions/_shared/grade-metrics.mjs'
import { m3Config, adminClient } from './family.mjs'

// a small PUBLIC handwritten-digit SEED (stand-in for a loaded MNIST-class set). Labels only —
// a real model reads the actual image in 5f-b; here it derisks the metric/pipeline.
const PUBLIC_SEED = [5, 42, 7, 64, 25, 1, 9, 18, 100, 3, 6, 8, 40, 12, 77, 0, 21, 33, 56, 88]

// a MOCK candidate: high-confidence-correct on most, a few LOW-confidence misreads — so the
// calibration curve is meaningful (high band ~perfect, errors concentrate in the low band).
function mockReader(truth, i) {
  return i % 5 === 4 ? { read: truth + 1, confidence: 0.4 } : { read: truth, confidence: 0.96 }
}

const cfg = m3Config()
const admin = adminClient(cfg)

// the REAL self-generated corpus (internal-only; empty until real confirmed grades accrue)
const { data: corpus } = await admin.rpc('benchmark_corpus', { p_limit: 10000 })
const realPairs = corpus?.pairs ?? []
console.log(`real self-generated corpus: ${realPairs.length} labeled (image, read) pair(s)`)

// score the mock candidate over the PUBLIC seed (the real set is fed to a model in 5f-b)
const rows = PUBLIC_SEED.map((truth, i) => ({ truth, ...mockReader(truth, i) }))
const em = exactMatch(rows)
const cal = calibration(rows)
const bar = clearsBar(cal)

console.log('exact-match:', JSON.stringify(em))
console.log('calibration:', JSON.stringify(cal))
console.log('clears-bar (illustrative):', JSON.stringify(bar))
console.log('\nNOTE: 5f-a proves the corpus + metrics pipeline on the PUBLIC seed with a MOCK reader.')
console.log('TrOCR-small / the CNN classifier are wired + benchmarked in 5f-b; the DEFAULT-SWAP')
console.log('(5f-c) fires only when a real candidate clears the bar on the REAL set + device matrix.')
process.exit(0)
