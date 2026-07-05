import { useEffect, useState } from 'react'
import { Panel } from '@/components/Panel'
import { ProgressRing } from '@/components/ProgressRing'
import { MasteryBar } from '@/components/MasteryBar'
import { getMastery, type SkillMastery } from '@/lib/api'
import type { Profile } from '@/lib/session'

export default function ParentHome({ profile }: { profile: Profile }) {
  const [byChild, setByChild] = useState<Record<string, SkillMastery[]>>({})

  useEffect(() => {
    let alive = true
    ;(async () => {
      const m: Record<string, SkillMastery[]> = {}
      for (const c of profile.children) m[c.id] = await getMastery(c.id)
      if (alive) setByChild(m)
    })()
    return () => { alive = false }
  }, [profile.children])

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Your children</h1>
        <p className="text-sm text-muted-foreground">Signed in as {profile.displayName}</p>
      </div>

      {profile.children.map((c) => {
        const skills = byChild[c.id] ?? []
        const avg = skills.length ? skills.reduce((s, x) => s + x.mastery, 0) / skills.length : 0
        return (
          <Panel key={c.id} className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <ProgressRing value={Math.round(avg * 100)} label={`${c.nickname} average mastery`} />
              <div className="flex-1">
                <p className="text-lg font-bold text-foreground">{c.nickname}</p>
                <p className="text-sm text-muted-foreground">
                  {c.grade_band ? `Grade ${c.grade_band}` : 'Learner'} · {skills.length} skill{skills.length === 1 ? '' : 's'} practiced
                </p>
              </div>
            </div>
            {skills.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {skills.map((s) => (
                  <li key={s.skillKey}>
                    <div className="mb-0.5 flex justify-between text-xs"><span className="font-medium text-foreground">{s.displayName}</span><span className="text-muted-foreground">{Math.round(s.mastery * 100)}% · {s.correct}/{s.attempts}</span></div>
                    <MasteryBar value={s.mastery} />
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No practice recorded yet.</p>}
          </Panel>
        )
      })}
    </div>
  )
}
