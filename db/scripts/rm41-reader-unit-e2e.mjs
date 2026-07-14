// ============================================================================
// RM-41 (unit) reader segmentation + the evidence-gated promotion mechanism (Phase 5 · 5f-c).
// Pure, fast, per-commit. Multi-digit projection segmentation, and the promotion gate that
// CANNOT promote a candidate without a bar-clearing result on the REAL set across the FULL
// device matrix — fully reversible; deterministic stays default. LOCAL only, no DB/stack.
// Run: node db/scripts/rm41-reader-unit-e2e.mjs
// ============================================================================
import { segmentDigits } from '../../hub/src/lib/localReaders/segment.mjs'
import { activeReader, evidenceClears, legClears, REQUIRED_LEGS, CURRENT_PROMOTION, READER_DEFAULT } from '../../hub/src/lib/localReaders/promotion.mjs'

let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }

// ---- segmentation ----
const mk = (w, h, ranges) => { const g = new Float32Array(w * h); for (const [a, b] of ranges) for (let x = a; x <= b; x++) for (let y = 2; y < h - 2; y++) g[y * w + x] = 1; return g }
const two = segmentDigits(mk(30, 12, [[2, 8], [15, 21]]), 30, 12)
two.length === 2 && two[0].x0 === 2 && two[0].x1 === 8 && two[1].x0 === 15 && two[1].x1 === 21
  ? ok('segmentation: two well-separated digits → two boxes at the right columns') : bad(`two: ${JSON.stringify(two)}`)
const one = segmentDigits(mk(30, 12, [[10, 18]]), 30, 12)
one.length === 1 ? ok('segmentation: one digit → one box') : bad(`one: ${JSON.stringify(one)}`)
const touch = segmentDigits(mk(30, 12, [[6, 24]]), 30, 12)
touch.length === 1 ? ok('segmentation: TOUCHING digits merge into one wide box (→ low confidence → gate escalates → human corrects; never a wrong grade)') : bad(`touch: ${JSON.stringify(touch)}`)
const none = segmentDigits(mk(30, 12, []), 30, 12)
none.length === 0 ? ok('segmentation: blank image → zero boxes') : bad(`none: ${JSON.stringify(none)}`)

// ---- promotion gate ----
const clearingLeg = { exact_match: 0.99, high_conf_exact_match: 0.999 }
const failingLeg = { exact_match: 0.90, high_conf_exact_match: 0.95 }
const fullMatrix = { webgpu: clearingLeg, wasm: clearingLeg, manual_old_iphone: clearingLeg }

CURRENT_PROMOTION === null && activeReader(CURRENT_PROMOTION) === READER_DEFAULT
  ? ok('DEFAULT: no promotion recorded → the deterministic reader is active') : bad(`current: ${activeReader(CURRENT_PROMOTION)}`)

// synthetic evidence, even clearing every leg, CANNOT promote — the flip needs the real set
activeReader({ candidate: 'cnn', on_real_set: false, evidence: fullMatrix }) === READER_DEFAULT
  ? ok('gate: SYNTHETIC evidence clearing every leg CANNOT promote (on_real_set=false → deterministic)') : bad('synthetic promoted')

// a MISSING device leg blocks promotion (full matrix required, incl. the manual old-iPhone leg)
activeReader({ candidate: 'cnn', on_real_set: true, evidence: { webgpu: clearingLeg, wasm: clearingLeg } }) === READER_DEFAULT
  ? ok('gate: a MISSING device leg (no manual old-iPhone) blocks promotion → deterministic') : bad('missing-leg promoted')

// a FAILING leg blocks promotion
activeReader({ candidate: 'cnn', on_real_set: true, evidence: { ...fullMatrix, manual_old_iphone: failingLeg } }) === READER_DEFAULT
  ? ok('gate: a FAILING leg (below the bar) blocks promotion → deterministic') : bad('failing-leg promoted')

// only a REAL-set record clearing EVERY leg promotes
activeReader({ candidate: 'cnn', on_real_set: true, evidence: fullMatrix }) === 'cnn' && evidenceClears(fullMatrix) && !legClears(failingLeg)
  ? ok('gate: a REAL-set record clearing EVERY device leg promotes the candidate (the only path)') : bad('real full-clear did not promote')

// impossible / out-of-range metrics do not clear (defense-in-depth on the gate)
!legClears({ exact_match: 2, high_conf_exact_match: 2 }) && !legClears({ exact_match: 0.99, high_conf_exact_match: 1.5 })
  ? ok('gate: impossible >1 metrics are rejected (metrics must be valid probabilities — no fabricated-evidence bypass)') : bad('out-of-range metric cleared the bar')

// fully reversible
activeReader(null) === READER_DEFAULT
  ? ok('REVERSIBLE: revoking the record (null) reverts to the deterministic default') : bad('not reversible')

console.log(fails ? `\n=== RM-41 UNIT: ${fails} FAIL ===` : '\n=== RM-41 UNIT: ALL PASS (projection segmentation incl. touching-digit safety net; promotion gate — synthetic/missing-leg/failing-leg all blocked, only real+full-matrix promotes, reversible) ===')
process.exit(fails ? 1 : 0)
