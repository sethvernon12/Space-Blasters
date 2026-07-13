// _shared/grade-benchmark.mjs — the local-vs-external benchmark DECISION. Phase 5 · 5b. Pure.
// LOCAL-FIRST: local crosses no border, so prefer it unless it misses the accuracy bar AND a
// certified external is MATERIALLY better. The decision is advisory — the registry border
// (provider-registry.mjs) is what actually gates a call, so a decision to use external still
// fails closed to local in the dev bundle (external is not bundle-included).
export function benchmarkDecision(local, external, opts = {}) {
  const bar = opts.accuracyBar ?? 0.90
  const margin = opts.margin ?? 0.05
  if (!local) return { provider: 'local', reason: 'no_local_score' }
  if (local.accuracy >= bar) return { provider: 'local', reason: 'local_meets_bar' }
  if (external && external.accuracy >= local.accuracy + margin && external.accuracy >= bar) {
    return {
      provider: external.provider,
      reason: 'external_materially_better',
      note: 'gated: external is advisory only — it runs ONLY if certified no-train/ZDR + bundle-included',
    }
  }
  return { provider: 'local', reason: 'local_best_available' }
}
