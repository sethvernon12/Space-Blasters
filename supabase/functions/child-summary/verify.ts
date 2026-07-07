import type { Pack } from './gateway/index.ts'

// Deterministic-solver verify hook: every percentage the summary states MUST be
// one the pack actually contains. For the mock this always holds; the seam stops
// a future real provider from emitting a fabricated figure — if it does, we drop
// to a numbers-free statement rather than show an invented number to a parent.
export function verifyClaims(pack: Pack, text: string): { ok: boolean; text: string } {
  const allowed = new Set((pack.skills ?? []).map((s) => Math.round((s.mastery ?? 0) * 100)))
  const claimed = [...text.matchAll(/(\d+)%/g)].map((m) => Number(m[1]))
  const ok = claimed.every((p) => allowed.has(p))
  return ok ? { ok: true, text } : { ok: false, text: 'Your learner has been practicing math — see the skill bars below for exact progress.' }
}
