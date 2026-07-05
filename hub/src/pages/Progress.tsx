import { Panel } from '@/components/Panel'
import { StrandGlyph } from '@/components/StrandGlyph'
import { ProgressRing } from '@/components/ProgressRing'
import { Badge } from '@/components/ui/badge'
import { Progress as ProgressBar } from '@/components/ui/progress'
import { SKILLS, SKILL_GROUPS, skillsInGroup } from '@/data/skills'
import type { Skill, SkillGroup } from '@/data/skills'

// Honest empty state: every one of the 23 skills reads "Not started". No
// percentages, no mastery, nothing fabricated — the ring is empty at 0.

function SkillRow({ skill }: { skill: Skill }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-surface-muted px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{skill.label}</span>
        <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
          Not started
        </Badge>
      </div>
      <ProgressBar value={0} aria-label={`${skill.label}: not started`} />
    </li>
  )
}

function StrandPanel({ group }: { group: SkillGroup }) {
  const skills = skillsInGroup(group)
  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <StrandGlyph group={group} />
        <div>
          <h2 className="text-base font-semibold text-foreground">{group}</h2>
          <p className="text-sm text-muted-foreground">
            {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
          </p>
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {skills.map((skill) => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
      </ul>
    </Panel>
  )
}

export default function Progress() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">My Progress</h1>
      <p className="mt-1 text-muted-foreground">
        Progress fills in once your practice is being recorded (coming soon).
      </p>

      <Panel className="mt-6 flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
        <ProgressRing value={0} label="Overall: not started" />
        <div>
          <p className="text-lg font-semibold text-foreground">0 of {SKILLS.length} skills started</p>
          <p className="text-sm text-muted-foreground">
            Every skill below is waiting for its first mission.
          </p>
        </div>
      </Panel>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {SKILL_GROUPS.map((group) => (
          <StrandPanel key={group} group={group} />
        ))}
      </div>
    </div>
  )
}
