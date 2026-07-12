// _shared/blast-radius.mjs — the storage-purge BLAST-RADIUS BREAKER, pure and runtime-
// agnostic (Deno edge worker + Node e2e both import THIS one implementation). No magic
// per-child number: the limit is self-calibrated to the child's own counted set.

// The cross-bucket backstop only engages once the bucket is non-trivial: a legitimate
// single family can be most of a NEAR-EMPTY bucket early on, so under the floor the exact
// per-child counted-set guard is authoritative. Bucket-scale threshold, NOT a per-child cap.
export const CROSS_BUCKET_FLOOR = 200

//   (a) per-child: delete AT MOST the child's own counted set. listedCount is what we
//       gathered to delete; it must equal child_count (same manifest). A mismatch means
//       the delete set came from a different source than the count → HALT.
//   (b) cross-bucket backstop: >25% of the whole bucket at/above the floor ⇒ a runaway /
//       empty-prefix bug ⇒ HALT + PAGE (impossible for a legitimate single child).
export function blastRadiusDecision({ childCount, bucketTotal, listedCount }) {
  if (listedCount !== childCount) return { proceed: false, reason: `child_overflow:${listedCount}!=${childCount}` }
  if (bucketTotal >= CROSS_BUCKET_FLOOR && childCount > 0.25 * bucketTotal) {
    return { proceed: false, reason: `cross_bucket:${childCount}/${bucketTotal}`, page: true }
  }
  return { proceed: true }
}
