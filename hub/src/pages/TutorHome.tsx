import { useCallback, useEffect, useState } from 'react'
import { Panel } from '@/components/Panel'
import { MasteryBar } from '@/components/MasteryBar'
import { createAssignment, createGrade, getMastery, listAssignments, type Assignment, type SkillMastery } from '@/lib/api'
import type { Profile } from '@/lib/session'

export default function TutorHome({ profile }: { profile: Profile }) {
  const [skillsByChild, setSkills] = useState<Record<string, SkillMastery[]>>({})
  const [assignsByChild, setAssigns] = useState<Record<string, Assignment[]>>({})
  const [title, setTitle] = useState('Practice Add within 5')
  const [flash, setFlash] = useState<string | null>(null)

  const load = useCallback(async () => {
    const m: Record<string, SkillMastery[]> = {}
    const a: Record<string, Assignment[]> = {}
    for (const c of profile.children) { m[c.id] = await getMastery(c.id); a[c.id] = await listAssignments(c.id) }
    setSkills(m); setAssigns(a)
  }, [profile.children])
  useEffect(() => { void load() }, [load])

  async function assign(childId: string) {
    const { error } = await createAssignment(childId, profile.uid, 'add5', title)
    setFlash(error ? `Could not assign: ${error.message}` : 'Assignment sent ✓')
    void load()
  }
  async function grade(childId: string, verdict: string) {
    const { error } = await createGrade(childId, profile.uid, { verdict, note: 'Reviewed by tutor' })
    setFlash(error ? `Could not grade: ${error.message}` : `Marked “${verdict}” ✓`)
    void load()
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Students you help</h1>
        <p className="text-sm text-muted-foreground">Signed in as {profile.displayName}</p>
      </div>
      {flash && <p className="rounded-xl bg-green-soft px-4 py-2 text-sm font-medium" style={{ color: 'var(--success)' }}>{flash}</p>}

      {profile.children.map((c) => {
        const skills = skillsByChild[c.id] ?? []
        const canWrite = !!profile.canWrite[c.id]
        return (
          <Panel key={c.id} className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-lg font-bold text-foreground">{c.nickname}</p>
              <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: canWrite ? 'var(--green-soft)' : 'var(--surface-muted)', color: canWrite ? 'var(--success)' : 'var(--muted-foreground)' }}>{canWrite ? 'Can teach' : 'View only'}</span>
            </div>
            {skills.length ? (
              <ul className="flex flex-col gap-2">
                {skills.map((s) => (
                  <li key={s.skillKey}>
                    <div className="mb-0.5 flex justify-between text-xs"><span className="font-medium text-foreground">{s.displayName}</span><span className="text-muted-foreground">{Math.round(s.mastery * 100)}% · {s.correct}/{s.attempts}</span></div>
                    <MasteryBar value={s.mastery} />
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No practice yet.</p>}

            {canWrite && (
              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className="min-h-11 flex-1 rounded-xl border border-border bg-card px-3 text-sm text-foreground" aria-label="Assignment title" />
                  <button type="button" onClick={() => assign(c.id)} className="min-h-11 rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground">Assign</button>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => grade(c.id, 'reviewed')} className="min-h-10 flex-1 rounded-full border border-border text-sm font-semibold text-foreground hover:bg-surface-muted">Mark reviewed ✓</button>
                  <button type="button" onClick={() => grade(c.id, 'needs-work')} className="min-h-10 flex-1 rounded-full border border-border text-sm font-semibold text-foreground hover:bg-surface-muted">Needs work</button>
                </div>
                {(assignsByChild[c.id]?.length ?? 0) > 0 && <p className="text-xs text-muted-foreground">{assignsByChild[c.id].length} assignment(s) sent</p>}
              </div>
            )}
          </Panel>
        )
      })}
    </div>
  )
}
