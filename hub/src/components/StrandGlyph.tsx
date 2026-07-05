// A strand's icon in a soft tinted chip, tinted by the strand color. Color is
// never the only signal — the icon + an adjacent label always accompany it.
import { Icon } from './Icon'
import { STRAND_META, type SkillGroup } from '@/data/skills'

export function StrandGlyph({ group, size = 40 }: { group: SkillGroup; size?: number }) {
  const m = STRAND_META[group]
  return (
    <span
      className="inline-grid shrink-0 place-items-center rounded-xl"
      style={{ width: size, height: size, background: m.softBg, color: m.color }}
    >
      <Icon name={m.iconName} size={Math.round(size * 0.5)} strokeWidth={2.4} />
    </span>
  )
}
