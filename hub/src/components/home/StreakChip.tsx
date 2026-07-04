import { Icon } from '@/components/Icon'

// Honest streak chip. There is no real streak tracking wired yet, so the REAL
// value is 0 — we never render "0 day streak". When days > 0 (future), show it;
// otherwise invite the child to begin.
export function StreakChip({ days = 0 }: { days?: number }) {
  const started = days > 0
  return (
    <span
      className="inline-flex min-h-11 items-center gap-2 rounded-full bg-gold-soft px-4 text-sm font-bold text-warning-text"
      role="status"
    >
      <Icon name="Flame" size={18} className="text-warning-text" />
      {started ? `${days}-day streak` : 'Start your streak today'}
    </span>
  )
}
