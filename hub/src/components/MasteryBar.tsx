// A single mastery bar. Honest: 0 shows an empty track.
export function MasteryBar({ value, tone = 'var(--success)' }: { value: number; tone?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-muted)' }}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: tone }} />
    </div>
  )
}
