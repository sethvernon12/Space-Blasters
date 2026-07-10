import { useCallback, useEffect, useState } from 'react'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { MasteryBar } from '@/components/MasteryBar'
import { PracticeModule } from '@/components/PracticeModule'
import { childExists, getMastery, listAssignments, nextBestActivity, type Assignment, type SkillMastery } from '@/lib/api'
import { GAME_URL } from '@/lib/config'
import type { Profile } from '@/lib/session'

function RemovedScreen() {
  return (
    <div className="grid min-h-[60vh] place-items-center" data-testid="child-removed">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <span style={{ color: 'var(--accent-purple)' }}><Icon name="Heart" size={40} /></span>
        <h1 className="text-xl font-bold text-foreground">Time for a break! 💙</h1>
        <p className="text-sm text-muted-foreground">Your learning space isn’t here right now. Please ask your parent or grown-up to help.</p>
      </div>
    </div>
  )
}

export default function ChildHome({ profile }: { profile: Profile }) {
  const child = profile.children[0]
  const [skills, setSkills] = useState<SkillMastery[] | null>(null)
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [practicing, setPracticing] = useState(false)
  // a reload of a deleted child resolves to `removed` in loadProfile; a mid-session
  // deletion is caught by the live check below.
  const [gone, setGone] = useState(Boolean(profile.removed) || !child)

  const load = useCallback(async () => {
    if (!child) return
    if (!(await childExists(child.id))) { setGone(true); return }
    setSkills(await getMastery(child.id))
    setAssignments(await listAssignments(child.id))
  }, [child])
  useEffect(() => { void load() }, [load])
  // catch a mid-session deletion without a reload: on tab focus and on a heartbeat.
  useEffect(() => {
    if (!child) return
    const check = () => { void childExists(child.id).then((ok) => { if (!ok) setGone(true) }) }
    const onVis = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVis)
    const t = setInterval(check, 15000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(t) }
  }, [child])

  if (gone || !child) return <RemovedScreen />

  if (practicing) {
    return <PracticeModule childId={child.id} childName={child.nickname} onExit={() => { setPracticing(false); void load() }} onRecorded={load} />
  }

  const next = skills && skills.length ? nextBestActivity(skills.find((s) => s.mastery < 0.85) ?? skills[skills.length - 1]) : null

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Hi, {child.nickname}! 👋</h1>
        <p className="text-sm text-muted-foreground">Ready for today’s math?</p>
      </div>

      <Panel className="flex items-center gap-4" style={{ background: 'var(--gold-soft)' }}>
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-card text-warning-text"><Icon name={next ? next.icon : 'Target'} size={26} /></span>
        <div className="flex-1">
          <p className="text-xs font-bold uppercase tracking-wide text-warning-text">Today’s focus</p>
          <p className="text-base font-bold text-foreground">{next ? next.displayName : 'Add within 5'}</p>
          <p className="text-sm text-muted-foreground">{next ? next.reason : 'Let’s start practicing!'}</p>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button type="button" onClick={() => setPracticing(true)} className="flex min-h-28 flex-col items-start justify-between rounded-2xl bg-primary p-5 text-left text-primary-foreground shadow-card">
          <Icon name="Target" size={28} />
          <span><span className="block text-lg font-bold">Practice Math</span><span className="block text-sm opacity-90">A quick set — Add within 5</span></span>
        </button>
        <a href={GAME_URL} target="_blank" rel="noreferrer" className="flex min-h-28 flex-col items-start justify-between rounded-2xl p-5 text-left shadow-card" style={{ background: 'var(--purple-soft)' }}>
          <span style={{ color: 'var(--accent-purple)' }}><Icon name="Rocket" size={28} /></span>
          <span><span className="block text-lg font-bold text-foreground">Space Blasters</span><span className="block text-sm text-muted-foreground">Play the math game</span></span>
        </a>
      </div>

      <Panel>
        <h2 className="text-base font-bold text-foreground">My math skills</h2>
        {skills === null ? <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
          : skills.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No practice yet — tap Practice Math to start!</p>
            : <ul className="mt-3 flex flex-col gap-3">
              {skills.map((s) => (
                <li key={s.skillKey}>
                  <div className="mb-1 flex items-center justify-between text-sm"><span className="font-semibold text-foreground">{s.displayName}</span><span className="text-muted-foreground">{Math.round(s.mastery * 100)}% · {s.correct}/{s.attempts}</span></div>
                  <MasteryBar value={s.mastery} />
                </li>
              ))}
            </ul>}
      </Panel>

      {assignments.length > 0 && (
        <Panel>
          <h2 className="text-base font-bold text-foreground">From your tutor</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {assignments.map((a) => <li key={a.id} className="flex items-center gap-2 text-sm text-foreground"><Icon name="ClipboardList" size={16} />{a.title}</li>)}
          </ul>
        </Panel>
      )}
    </div>
  )
}
