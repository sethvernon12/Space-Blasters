// segment.mjs — Phase 5 · 5f-c. Projection-based digit segmentation. Pure + runtime-agnostic
// (hub + node tests share it). Splits a grayscale image into digit column-regions by the vertical
// ink profile: contiguous columns with ink are a digit, whitespace columns separate digits.
//
// The safety net makes perfection unnecessary: if two digits TOUCH, projection merges them into
// one wide region → the classifier reads it as a single (likely wrong) digit → that digit's
// confidence is low → the multi-digit combine takes the MIN confidence → the automation-bias-
// resistant gate escalates → the human corrects. A touching-digit failure routes to review,
// never a wrong recorded grade. Connected-components is the documented fallback refinement.
export function segmentDigits(gray, w, h, opts = {}) {
  const inkThreshold = opts.inkThreshold ?? 0.10   // per-column mean ink to count a column as "digit"
  const minWidth = opts.minWidth ?? 2              // ignore specks narrower than this
  const norm = (v) => (v > 1 ? v / 255 : v)
  const col = new Float32Array(w)
  for (let x = 0; x < w; x++) { let s = 0; for (let y = 0; y < h; y++) s += norm(gray[y * w + x]); col[x] = s / h }
  const boxes = []
  let x = 0
  while (x < w) {
    while (x < w && col[x] < inkThreshold) x++          // skip whitespace
    if (x >= w) break
    const x0 = x
    while (x < w && col[x] >= inkThreshold) x++          // consume the ink run
    const x1 = x - 1
    if (x1 - x0 + 1 >= minWidth) boxes.push({ x0, x1 })
  }
  return boxes
}
