import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface TileProps {
  title: string
  description: string
  /** An emoji, rendered aria-hidden; the link itself carries ariaLabel. */
  icon: string
  ariaLabel: string
  accent: 'primary' | 'cyan' | 'gold' | 'mint'
  /** Internal route — rendered as a react-router <Link>. */
  to?: string
  /** External top-level link — plain <a>, same tab (the game needs pointer lock, audio and the mic). */
  href?: string
  /** Hero-sized variant. */
  big?: boolean
  /** e.g. 'Coming soon' */
  badge?: string
}

const ACCENTS: Record<TileProps['accent'], { edge: string; chip: string; hover: string }> = {
  primary: {
    edge: 'border-l-primary/70',
    chip: 'bg-primary/15 text-primary',
    hover: 'hover:border-primary/60',
  },
  cyan: {
    edge: 'border-l-cyan/70',
    chip: 'bg-cyan/10 text-cyan',
    hover: 'hover:border-cyan/60',
  },
  gold: {
    edge: 'border-l-gold/70',
    chip: 'bg-gold/10 text-gold',
    hover: 'hover:border-gold/60',
  },
  mint: {
    edge: 'border-l-mint/70',
    chip: 'bg-mint/10 text-mint',
    hover: 'hover:border-mint/60',
  },
}

export function Tile({
  title,
  description,
  icon,
  ariaLabel,
  accent,
  to,
  href,
  big = false,
  badge,
}: TileProps) {
  const a = ACCENTS[accent]
  const Heading = big ? 'h2' : 'h3'

  const className = cn(
    'relative block w-full min-h-12 rounded-2xl border border-border border-l-2 bg-card',
    'transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-0.5',
    a.edge,
    a.hover,
    big
      ? // hero: stronger game-palette presence — orange/gold glow border
        'min-h-36 border-primary/40 border-l-primary p-6 shadow-[0_0_28px_rgba(255,142,60,0.16),inset_0_1px_0_rgba(255,211,110,0.18)] hover:border-primary/70 hover:shadow-[0_0_36px_rgba(255,142,60,0.28),inset_0_1px_0_rgba(255,211,110,0.24)] sm:p-8'
      : 'p-5',
  )

  const panel = (
    <>
      {badge ? (
        <Badge
          variant="outline"
          className="absolute right-4 top-4 border-border text-hud"
        >
          {badge}
        </Badge>
      ) : null}
      <div className={cn('flex items-center', big ? 'gap-5' : 'gap-4')}>
        <span
          aria-hidden="true"
          className={cn(
            'flex shrink-0 items-center justify-center rounded-xl',
            a.chip,
            big ? 'size-20 text-5xl sm:size-24 sm:text-6xl' : 'size-12 text-2xl',
          )}
        >
          {icon}
        </span>
        <div className={cn('min-w-0', badge && 'pr-24')}>
          <Heading
            className={cn(
              'font-bold text-[#dfe9ff]',
              big ? 'text-2xl sm:text-3xl' : 'text-base',
            )}
          >
            {title}
          </Heading>
          <p className={cn('mt-1 text-hud', big ? 'text-base' : 'text-sm')}>
            {description}
          </p>
        </div>
      </div>
    </>
  )

  if (to) {
    return (
      <Link to={to} aria-label={ariaLabel} className={className}>
        {panel}
      </Link>
    )
  }
  return (
    <a href={href} aria-label={ariaLabel} className={className}>
      {panel}
    </a>
  )
}
