// _shared/gateway.ts — the ONE model door for every AI touchpoint. Provider-
// agnostic + FAIL-CLOSED: only providers with a signed ZDR/no-train agreement
// are eligible; none is signed, so the deterministic mock is the door. A real
// provider slots in by flipping zdrSigned + supplying gen() — no caller change.
export interface GenResult { text: string; provider: string; model: string }
export interface SummaryInput { skills: Array<{ display_name: string; mastery: number; attempts: number; correct: number }> }
export interface GradeInput { skill_display: string; correct: boolean; correct_answer: number; submitted_answer: number | null }

function mockSummary(inp: SummaryInput): string {
  const skills = inp.skills ?? []
  if (!skills.length) return 'No math practice has been recorded yet. Once your learner starts practicing, a progress summary will appear here.'
  const parts = skills.map((s) => {
    const pct = Math.round((s.mastery ?? 0) * 100)
    const band = pct >= 85 ? 'has mastered' : pct >= 60 ? 'is making strong progress on' : pct >= 40 ? 'is building' : 'is just starting'
    return `${band} ${s.display_name} (${pct}%, ${s.correct} of ${s.attempts} correct)`
  })
  const top = skills.reduce((a, b) => (b.mastery > a.mastery ? b : a))
  return `This week your learner ${parts.join('; ')}. Strongest area: ${top.display_name} at ${Math.round(top.mastery * 100)}%. A little regular practice keeps the momentum going.`
}

function mockGrade(inp: GradeInput): string {
  if (inp.correct) return `Correct — nice work on ${inp.skill_display}! You answered ${inp.correct_answer}. Keep it up.`
  return `Not quite on ${inp.skill_display}. You answered ${inp.submitted_answer}; the answer is ${inp.correct_answer}. Let's review this one together — you're close!`
}

function mockGen(task: string, input: unknown): GenResult {
  const text = task === 'summary' ? mockSummary(input as SummaryInput)
    : task === 'grade' ? mockGrade(input as GradeInput) : ''
  return { text, provider: 'mock', model: 'deterministic-v1' }
}

const REGISTRY: Array<{ name: string; zdrSigned: boolean; gen: ((task: string, input: unknown) => GenResult) | null }> = [
  { name: 'anthropic', zdrSigned: false, gen: null }, // INELIGIBLE until a ZDR agreement is signed
  { name: 'mock', zdrSigned: true, gen: mockGen },      // deterministic; no data leaves the box
]

export function runGateway(task: string, input: unknown, _opts: { promptVersion: string }): GenResult {
  const p = REGISTRY.filter((x) => x.zdrSigned && x.gen)[0]
  if (!p || !p.gen) throw new Error('no_eligible_provider') // fail-closed
  return p.gen(task, input)
}
