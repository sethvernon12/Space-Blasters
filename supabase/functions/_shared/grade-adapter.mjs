// _shared/grade-adapter.mjs — the guardrailed grade adapter boundary. Phase 5 · 5b.
// Supersedes the 5a mock. Pure logic + a local reader; NO external call is reachable in the
// dev bundle (the external reader module is not imported here — tree-shaken).
//
// Contract: select a provider (LOCAL-FIRST) → enforce the BORDER via the fail-closed registry
// (external only if certified + bundle_included, else refuse) → call the provider with INLINE
// image bytes (never a fetchable URL handed to any external party) → validate the strict
// output schema. The deterministic solver remains the sole arbiter; this only REPORTS a read.
import { selectProvider, assertCallable } from './provider-registry.mjs'
import { localRead } from './grade-local-reader.mjs'
import { validateGradeOutput } from './grade-schema.mjs'

// gradeAdapter(job, imageBytes, opts?) → { ok, output? , error? }
// imageBytes: a Uint8Array (or null) passed INLINE — the adapter never receives or emits a URL.
export function gradeAdapter(job, imageBytes, opts = {}) {
  const provider = selectProvider(opts.decision)
  const gate = assertCallable(provider)
  if (!gate.ok) return { ok: false, error: `provider_blocked:${gate.reason}` } // fail closed

  let raw
  if (provider === 'local') {
    raw = localRead(job, imageBytes) // in-process, crosses no border
  } else {
    // External path: reachable ONLY if certified + bundle_included. In the dev bundle the
    // external reader is not imported, so even a mis-registered external fails closed here.
    return { ok: false, error: 'external_unavailable_in_bundle' }
  }

  const v = validateGradeOutput(raw)
  if (!v.ok) return { ok: false, error: `bad_output:${v.reason}` }
  return { ok: true, output: v.value }
}
