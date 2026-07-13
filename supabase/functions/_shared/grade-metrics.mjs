// _shared/grade-metrics.mjs — Phase 5 · 5f-a. The benchmark METRICS for the read-a-handwritten-
// number task. Pure + runtime-agnostic. The metric is WHOLE-NUMBER exact-match (not prose CER),
// because a faithful read is all the model must produce (the deterministic solver decides
// correctness). Confidence CALIBRATION is the second metric: per-confidence-band exact-match, so
// the gate can auto-accept high-confidence reads and route the rest to a human — the confidence
// is a ROUTING signal, never a gate on correctness.

// rows: [{ read: int|null, truth: int }]
export function exactMatch(rows) {
  const n = rows.length
  const answered = rows.filter((r) => r.read !== null && r.read !== undefined).length
  const correct = rows.filter((r) => r.read !== null && r.read !== undefined && r.read === r.truth).length
  return { n, answered, correct, rate: n ? correct / n : 0, precision: answered ? correct / answered : 0 }
}

// rows: [{ read, truth, confidence: 0..1 }]. Returns per-band exact-match, high band first.
export function calibration(rows, thresholds = [0.9, 0.75, 0.5, 0]) {
  const cuts = [...new Set(thresholds)].sort((x, y) => y - x)
  return cuts.map((lo, i) => {
    const hi = i === 0 ? Infinity : cuts[i - 1]
    const inBand = rows.filter((r) => typeof r.confidence === 'number' && r.confidence >= lo && r.confidence < hi)
    const correct = inBand.filter((r) => r.read !== null && r.read !== undefined && r.read === r.truth).length
    return { lo, hi: hi === Infinity ? 1 : hi, n: inBand.length, exact_match: inBand.length ? correct / inBand.length : null }
  })
}

// A candidate clears the ship bar when the HIGH-confidence band is essentially exact AND almost
// every real error falls into the low-confidence (route-to-human) bucket. Bar values are set at
// the real-family/promotion gate; this just evaluates a result against them.
export function clearsBar(cal, { highBandFloor = 0.99, highBandMin = 0.5, maxLeakedErrorRate = 0.02 } = {}) {
  const high = cal.find((band) => band.lo >= 0.9)
  if (!high || high.n === 0) return { cleared: false, reason: 'no_high_confidence_sample' }
  const highOk = high.exact_match !== null && high.exact_match >= highBandFloor
  const coverage = high.n >= highBandMin // interpreted by caller as a fraction of total upstream
  // "leaked errors" = wrong reads that were NOT routed to human (i.e. high-confidence wrong reads)
  const leaked = high.n ? (1 - (high.exact_match ?? 0)) : 1
  return { cleared: highOk && leaked <= maxLeakedErrorRate, highExactMatch: high.exact_match, leaked, coverage }
}
