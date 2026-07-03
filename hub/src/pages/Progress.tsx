import { Badge } from '@/components/ui/badge'
import { SKILLS, SKILL_GROUPS } from '@/data/skills'
import type { Skill, SkillGroup } from '@/data/skills'

function StarIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className="shrink-0 text-hud/50"
      aria-hidden="true"
    >
      <path d="M12 2.5l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.52l-5.88 3.09 1.12-6.55L2.48 9.42l6.58-.96L12 2.5z" />
    </svg>
  )
}

function SkillCard({ skill }: { skill: Skill }) {
  return (
    <li className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <StarIcon />
      <span className="flex-1 text-sm text-[#dfe9ff]">{skill.label}</span>
      <Badge variant="outline" className="border-border text-hud">
        Not started
      </Badge>
    </li>
  )
}

function GroupSection({ group }: { group: SkillGroup }) {
  const skills = SKILLS.filter((s) => s.group === group).sort(
    (a, b) => a.position - b.position,
  )
  return (
    <section className="relative border-l border-dotted border-hud/25 pl-5">
      <span
        aria-hidden="true"
        className="absolute -left-[3px] top-1 size-[5px] rounded-full bg-hud/40"
      />
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-hud">
        {group}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((skill) => (
          <SkillCard key={skill.id} skill={skill} />
        ))}
      </ul>
    </section>
  )
}

export default function Progress() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-[#dfe9ff]">My Progress</h1>
      <p className="mt-1 text-sm text-hud">
        Progress starts filling in once your practice is being recorded (coming
        soon).
      </p>
      <div className="mt-8 flex flex-col gap-10">
        {SKILL_GROUPS.map((group) => (
          <GroupSection key={group} group={group} />
        ))}
      </div>
    </div>
  )
}
