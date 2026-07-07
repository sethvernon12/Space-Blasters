// A single mastery bar. Honest: 0 shows an empty track. Default fill is the
// game's cyan→mint sweep so hub and game read as one world.
export function MasteryBar({ value, tone = 'linear-gradient(90deg, var(--cyan-bright), var(--success))' }: { value: number; tone?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-muted)' }}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: tone }} />
    </div>
  )
}
