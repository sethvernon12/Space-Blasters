// _shared/solver.ts — the deterministic solver: the ARBITER of numeric
// correctness (AI-4). The model never decides whether an answer is right.
export function solveMath(problemDna: { correct_answer?: number | string } | null, submittedAnswer: number | null): { correct: boolean; correctAnswer: number } {
  const correctAnswer = Number(problemDna?.correct_answer)
  const correct = submittedAnswer != null && Number(submittedAnswer) === correctAnswer
  return { correct, correctAnswer }
}
