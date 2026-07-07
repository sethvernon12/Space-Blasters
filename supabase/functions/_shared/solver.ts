// _shared/solver.ts — the deterministic solver: the ARBITER of numeric
// correctness (AI-4). The model never decides. RECOMPUTES the answer from
// operator + operands; any client-supplied `correct_answer` is IGNORED (the
// authoritative recompute also runs server-side in approve_grade).
export function solveMath(problemDna: { operator?: string; operands?: Array<number | string> } | null, submittedAnswer: number | null): { correct: boolean; correctAnswer: number } {
  const ops = (problemDna?.operands ?? []).map(Number)
  const op = problemDna?.operator
  let correctAnswer = Number.NaN
  if (ops.length >= 2 && ops.every((n) => !Number.isNaN(n))) {
    correctAnswer = op === '+' ? ops[0] + ops[1] : op === '-' ? ops[0] - ops[1] : op === '*' ? ops[0] * ops[1] : Number.NaN
  }
  const correct = submittedAnswer != null && !Number.isNaN(correctAnswer) && Number(submittedAnswer) === correctAnswer
  return { correct, correctAnswer }
}
