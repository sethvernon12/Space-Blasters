// _shared/verify.ts — the outbound verify hook (KER-5): every number the model
// states MUST be one the deterministic layer produced; otherwise drop to a safe,
// numbers-free string rather than show a fabricated figure to a parent or child.
export function verifyNumbers(allowed: Set<number>, text: string, pattern: RegExp, fallback: string): { ok: boolean; text: string } {
  const claimed = [...text.matchAll(pattern)].map((m) => Number(m[1]))
  const ok = claimed.every((n) => allowed.has(n))
  return ok ? { ok: true, text } : { ok: false, text: fallback }
}
