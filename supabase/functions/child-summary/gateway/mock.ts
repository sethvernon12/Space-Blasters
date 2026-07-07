import type { Pack, GenResult } from './index.ts'

// Deterministic summary computed straight from the whitelist pack. It has NO
// name to leak (the pack carries none), and every number comes from recorded
// data — it invents nothing.
export function mockProvider(pack: Pack, _opts: { promptVersion: string }): GenResult {
  const skills = pack.skills ?? []
  let text: string
  if (!skills.length) {
    text = 'No math practice has been recorded yet. Once your learner starts practicing, a progress summary will appear here.'
  } else {
    const parts = skills.map((s) => {
      const pct = Math.round((s.mastery ?? 0) * 100)
      const band = pct >= 85 ? 'has mastered' : pct >= 60 ? 'is making strong progress on' : pct >= 40 ? 'is building' : 'is just starting'
      return `${band} ${s.display_name} (${pct}%, ${s.correct} of ${s.attempts} correct)`
    })
    const top = skills.reduce((a, b) => (b.mastery > a.mastery ? b : a))
    text = `This week your learner ${parts.join('; ')}. Strongest area: ${top.display_name} at ${Math.round(top.mastery * 100)}%. A little regular practice keeps the momentum going.`
  }
  return { text, provider: 'mock', model: 'deterministic-summary-v1' }
}
