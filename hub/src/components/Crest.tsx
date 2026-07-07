// The Academy crest — self-contained inline SVG (offline-safe, theme-aware via
// design tokens): a deep-navy shield, a gold star, an athletic cyan swoosh.
// One brand mark across the hub; the game (arcade) is synced in a later step.
export function Crest({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} role="img" aria-label="The All-Around Athlete Academy crest">
      <path d="M20 3 L34 8 V20 C34 29 27.5 35 20 37 C12.5 35 6 29 6 20 V8 Z"
        fill="var(--primary)" stroke="var(--gold)" strokeWidth="1.6" />
      <path d="M20 11 l2.25 4.65 5.1 .55 -3.8 3.55 1 5.05 -4.55 -2.55 -4.55 2.55 1 -5.05 -3.8 -3.55 5.1 -.55 Z"
        fill="var(--gold)" />
      <path d="M12.5 26.5 q7.5 4.2 15 0" fill="none" stroke="var(--cyan-bright)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
