import { mockProvider } from './mock.ts'

export interface Pack {
  child_id: string
  subject: string
  skills: Array<{ skill_id: string; display_name: string; subject: string; mastery: number; attempts: number; correct: number }>
}
export interface GenResult { text: string; provider: string; model: string }

// The single model door — provider-agnostic + FAIL-CLOSED. Only providers with a
// signed ZDR / no-train agreement are eligible. None is signed yet, so the
// deterministic MOCK is the door. A real provider slots in here (a later, gated
// step) by flipping zdrSigned true and supplying generate() — no caller changes.
const REGISTRY: Array<{ name: string; zdrSigned: boolean; generate: ((p: Pack, o: { promptVersion: string }) => GenResult) | null }> = [
  { name: 'anthropic', zdrSigned: false, generate: null }, // real slot — INELIGIBLE until an agreement is signed
  { name: 'mock', zdrSigned: true, generate: mockProvider }, // deterministic; no data leaves the box
]

export function generateSummary(pack: Pack, opts: { promptVersion: string }): GenResult {
  const eligible = REGISTRY.filter((p) => p.zdrSigned && p.generate)
  const provider = eligible[0]
  if (!provider || !provider.generate) throw new Error('no_eligible_provider') // fail-closed
  return provider.generate(pack, opts)
}
