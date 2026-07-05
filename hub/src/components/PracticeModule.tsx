import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { MasteryBar } from '@/components/MasteryBar'
import { recordAttemptsAuthed, type AttemptDraft } from '@/lib/api'

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
const rnd = (n: number) => Math.floor(Math.random() * n)
const SET_SIZE = 5

interface Problem { text: string; answer: number; options: number[]; answered?: boolean; correct?: boolean }
function makeProblem(): Problem {
  const s = 2 + rnd(4)
  const a = 1 + rnd(s - 1)
  const b = s - a
  const ans = a + b
  const opts = new Set<number>([ans])
  while (opts.size < 4) { const d = ans + (rnd(5) - 2); if (d >= 0 && d <= 9) opts.add(d) }
  return { text: `${a} + ${b}`, answer: ans, options: [...opts].sort(() => rnd(3) - 1) }
}

// The Milestone-1 practice loop, re-skinned to the light Veritas hub. Records
// through record_attempts_authed on the child's own session (RLS-scoped).
export function PracticeModule({ childId, childName, onExit, onRecorded }: {
  childId: string; childName: string; onExit: () => void; onRecorded: () => void
}) {
  const session = useMemo(uuid, [])
  const [problems] = useState<Problem[]>(() => Array.from({ length: SET_SIZE }, makeProblem))
  const [idx, setIdx] = useState(0)
  const [events, setEvents] = useState<AttemptDraft[]>([])
  const [correct, setCorrect] = useState(0)
  const [phase, setPhase] = useState<'play' | 'done'>('play')
  const [recorded, setRecorded] = useState<number | null>(null)
  const shownAt = useRef<number>(performance.now())

  useEffect(() => { shownAt.current = performance.now() }, [idx])

  async function finish(all: AttemptDraft[]) {
    setPhase('done')
    const res = await recordAttemptsAuthed(childId, all)
    setRecorded(res?.ok ? res.inserted : 0)
    onRecorded()
  }

  function answer(val: number, method: string) {
    const p = problems[idx]
    if (p.answered) return
    p.answered = true
    const isRight = val === p.answer
    p.correct = isRight
    if (isRight) setCorrect((c) => c + 1)
    const draft: AttemptDraft = {
      clientAttemptId: uuid(), clientSessionId: session, stageIndex: 0, skill: 'addition',
      result: isRight ? 'correct' : 'incorrect', problemText: p.text, correctAnswer: p.answer,
      chosenAnswer: val, responseMs: Math.round(performance.now() - shownAt.current), inputMethod: method,
      runTimeS: performance.now() / 1000, level: 1, context: { source: 'hub-practice' },
    }
    const next = [...events, draft]
    setEvents(next)
    setTimeout(() => { if (idx + 1 >= SET_SIZE) void finish(next); else setIdx(idx + 1) }, 380)
  }

  useEffect(() => {
    if (phase !== 'play') return
    const h = (e: KeyboardEvent) => {
      const p = problems[idx]
      if (!p || p.answered) return
      if (e.key >= '1' && e.key <= '4') { const o = p.options[Number(e.key) - 1]; if (o !== undefined) answer(o, 'typed') }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  if (phase === 'done') {
    const pct = events.length ? correct / events.length : 0
    return (
      <Panel className="text-center">
        <span className="inline-grid size-12 place-items-center rounded-2xl bg-green-soft" style={{ color: 'var(--success)' }}><Icon name="Check" size={26} /></span>
        <h2 className="mt-3 text-xl font-bold text-foreground">Great work, {childName}!</h2>
        <p className="mt-1 text-sm text-muted-foreground">{correct} of {events.length} correct on Add within 5</p>
        <div className="mx-auto mt-4 max-w-xs"><MasteryBar value={pct} /></div>
        <p className="mt-3 text-sm font-medium" style={{ color: recorded ? 'var(--success)' : 'var(--muted-foreground)' }}>
          {recorded === null ? 'Saving…' : recorded > 0 ? `✓ ${recorded} answers recorded` : '⚠ could not save'}
        </p>
        <button type="button" onClick={onExit} className="mt-5 inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 text-base font-bold text-primary-foreground">Back to my hub</button>
      </Panel>
    )
  }

  const p = problems[idx]
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button type="button" onClick={onExit} className="flex min-h-9 items-center gap-1 rounded-full border border-border px-3 text-sm text-muted-foreground hover:bg-surface-muted"><Icon name="ChevronLeft" size={16} />Back</button>
        <span className="text-sm font-semibold text-foreground">Add within 5</span>
        <span className="ml-auto flex gap-1.5">
          {problems.map((q, i) => <span key={i} className="size-2.5 rounded-full" style={{ background: i < idx ? (q.correct ? 'var(--success)' : 'var(--danger)') : i === idx ? 'var(--primary)' : 'var(--border-strong)' }} />)}
        </span>
      </div>
      <Panel className="text-center">
        <div className="text-6xl font-black tracking-wide text-foreground sm:text-7xl">{p.text}</div>
        <p className="mt-2 text-sm text-muted-foreground">Tap your answer, or press its number</p>
      </Panel>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {p.options.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={() => answer(o, 'tap')}
            className="min-h-20 rounded-2xl border-2 border-border bg-card text-4xl font-extrabold text-foreground transition-transform hover:border-[color:var(--primary)] active:scale-95"
            style={p.answered && o === p.answer ? { borderColor: 'var(--success)', background: 'var(--green-soft)' } : undefined}
          >
            {o}
          </button>
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground">Keyboard: press 1–4</p>
    </div>
  )
}
