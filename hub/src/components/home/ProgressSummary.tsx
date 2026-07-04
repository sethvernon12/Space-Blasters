import { Link } from 'react-router-dom'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { ProgressRing } from '@/components/ProgressRing'
import { StrandGlyph } from '@/components/StrandGlyph'
import { Progress } from '@/components/ui/progress'
import { SKILLS, SKILL_GROUPS, skillsInGroup } from '@/data/skills'

// My progress. Nothing is recorded yet, so every value is honestly 0 / Not
// started — no mastery, no percentages invented. The six strands appear in the
// canonical SKILL_GROUPS order.
export function ProgressSummary() {
  const totalSkills = SKILLS.length // 23

  return (
    <Panel className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">My progress</h2>
        <Link
          to="/progress"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline"
        >
          View all
          <Icon name="ArrowRight" size={16} />
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <ProgressRing value={0} label="Overall: not started" />
        <p className="text-muted-foreground">0 of {totalSkills} skills started</p>
      </div>

      <ul className="flex flex-col gap-3">
        {SKILL_GROUPS.map((group) => {
          const count = skillsInGroup(group).length
          return (
            <li key={group} className="flex items-center gap-3">
              <StrandGlyph group={group} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {group}{' '}
                    <span className="font-normal text-muted-foreground">
                      ({count} {count === 1 ? 'skill' : 'skills'})
                    </span>
                  </span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    Not started
                  </span>
                </div>
                <Progress value={0} className="mt-1.5" />
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-sm text-muted-foreground">
        Progress fills in once your practice is being recorded (coming soon).
      </p>
    </Panel>
  )
}
