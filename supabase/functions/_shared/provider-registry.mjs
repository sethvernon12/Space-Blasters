// _shared/provider-registry.mjs — THE BORDER. Phase 5 · 5b. A grading provider may be
// called ONLY through this fail-closed registry. Pure + runtime-agnostic (worker + tests
// share one implementation).
//
// Rule (stewardship & strong-borders §1): the interior is open (our consented AI sees the
// child's name + work), but the EDGE is guarded. An EXTERNAL model vendor is callable ONLY
// if it is registered AND attested no_train AND zero_retention AND bundle_included. A LOCAL
// provider crosses NO border and is always callable when registered.
//
// In dev/synthetic NO external provider is bundle_included, and the external call
// implementation is NOT imported anywhere in the dev bundle (tree-shaken) — so external is
// structurally UNREACHABLE. Flipping bundle_included true (and importing the external reader)
// is a deliberate real-family-gate step, never a dev default.
export const PROVIDERS = {
  // local crosses no border — in-process, no network. The dev reader is the seam for the
  // real local vision model dropped in at the gate.
  local: { kind: 'local', no_train: true, zero_retention: true, bundle_included: true },
  // External vendors are DECLARED for the record + the benchmark baseline, but NOT bundled
  // in dev (bundle_included:false). Their call implementation lives in a separate module
  // imported ONLY at the real-family gate. Example (kept commented so it can't be reached):
  //   'anthropic-vision': { kind: 'external', no_train: true, zero_retention: true, bundle_included: false },
  //   'openai-vision':    { kind: 'external', no_train: true, zero_retention: true, bundle_included: false },
}

export function isRegistered(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name)
}

// FAIL CLOSED. Returns { ok, reason?, provider? }. Local: ok when registered. External: ok
// ONLY when registered + no_train + zero_retention + bundle_included (all four).
export function assertCallable(name) {
  if (!isRegistered(name)) return { ok: false, reason: 'unregistered' } // own-property only: '__proto__'/'constructor' never resolve
  const p = PROVIDERS[name]
  if (p.kind === 'local') return { ok: true, provider: p }
  // external: EVERY attestation must be strictly true (a mis-authored non-boolean is refused)
  if (!(p.no_train === true && p.zero_retention === true && p.bundle_included === true)) {
    return { ok: false, reason: 'external_not_certified_or_not_bundled' }
  }
  return { ok: true, provider: p }
}

// Local-first selection. Honors a benchmark decision only if it names a CALLABLE provider;
// otherwise falls back to local (which crosses no border) — never silently reach for an
// uncertified/unbundled external vendor.
export function selectProvider(decision) {
  const want = (decision && decision.provider) || 'local'
  return assertCallable(want).ok ? want : 'local'
}
