// promotion.mjs — Phase 5 · 5f-c. The EVIDENCE-GATED reader-promotion mechanism. Pure. A
// candidate becomes the default reader ONLY when a recorded promotion carries benchmark evidence
// that CLEARS THE BAR on EVERY required device-matrix leg AND was measured on the REAL self-
// generated set. No/partial/synthetic evidence → 'deterministic' (the default). Fully reversible
// (a null record reverts to deterministic). The bar numbers are PLACEHOLDERS set for real at the
// LEG-05 gate on real child handwriting; the mechanism just evaluates a result against them.
export const READER_DEFAULT = 'deterministic'
// the device matrix — the automated legs plus the MANUAL real-old-iPhone leg (a founder/ops
// action recorded at the gate; a real device can't be automated in CI).
export const REQUIRED_LEGS = ['webgpu', 'wasm', 'manual_old_iphone']
export const PROMOTION_BAR = { exactMatch: 0.98, highConfExactMatch: 0.995, maxLeakedErrorRate: 0.01 }

export function legClears(result, bar = PROMOTION_BAR) {
  if (!result || typeof result.exact_match !== 'number') return false
  const hi = typeof result.high_conf_exact_match === 'number' ? result.high_conf_exact_match : 0
  const leaked = 1 - hi
  return result.exact_match >= bar.exactMatch && hi >= bar.highConfExactMatch && leaked <= bar.maxLeakedErrorRate
}

// EVERY required device leg must have a bar-clearing result — a missing or failing leg blocks it.
export function evidenceClears(evidence, bar = PROMOTION_BAR) {
  if (!evidence) return false
  return REQUIRED_LEGS.every((leg) => legClears(evidence[leg], bar))
}

// The active reader. Deterministic UNLESS a valid promotion record clears every leg AND is on the
// REAL set (synthetic-only evidence NEVER promotes — the flip needs real-family evidence).
export function activeReader(record, bar = PROMOTION_BAR) {
  if (!record || !record.candidate || record.candidate === READER_DEFAULT) return READER_DEFAULT
  if (record.on_real_set !== true) return READER_DEFAULT              // synthetic proves the mechanism, never promotes
  return evidenceClears(record.evidence, bar) ? record.candidate : READER_DEFAULT
}

// CURRENT promotion — null: deterministic is default; no candidate has real-family evidence yet.
// A real promotion at the flip is a deliberate, server-recorded, audited decision.
export const CURRENT_PROMOTION = null
