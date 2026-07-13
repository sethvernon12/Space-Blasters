// The local-reader seam (Phase 5 · 5f-b). The DETERMINISTIC reader is the default and STAYS the
// default through 5f-b; the CNN is a CANDIDATE — run only in the benchmark harness, never
// promoted here. The only way a candidate becomes default is a deliberate 5f-c promotion, gated
// on the real self-generated set clearing the accuracy/calibration bar across a device matrix.
// The external no-train/ZDR provider is NOT registered here at all — bundle-excluded and
// structurally unreachable; adding it is a separate real-family/supply-chain-review gate.
export type ReaderId = 'deterministic' | 'cnn'
export const LOCAL_READER_DEFAULT: ReaderId = 'deterministic'
export const READER_CANDIDATES: readonly ReaderId[] = ['cnn'] // benchmarked only; not default in 5f-b
export const EXTERNAL_READER_BUNDLE_EXCLUDED = true
