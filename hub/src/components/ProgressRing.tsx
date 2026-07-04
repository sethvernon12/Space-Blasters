// A small circular progress indicator. Honest: 0 shows an empty ring.
export function ProgressRing({
  value, size = 72, stroke = 8, label,
}: { value: number; size?: number; stroke?: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, value))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = (pct / 100) * c
  return (
    <div className="relative inline-grid place-items-center" role="img"
      aria-label={label ?? `${Math.round(pct)} percent`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="var(--surface-muted)" strokeWidth={stroke} />
        {pct > 0 && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="var(--primary)" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`} />
        )}
      </svg>
      <span className="absolute text-sm font-semibold text-foreground">{Math.round(pct)}%</span>
    </div>
  )
}
