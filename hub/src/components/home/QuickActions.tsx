import { Link } from 'react-router-dom'
import { Panel } from '@/components/Panel'
import { Icon, type IconName } from '@/components/Icon'
import { cn } from '@/lib/utils'

interface Action {
  to: string
  icon: IconName
  label: string
  primary?: boolean
}

const ACTIONS: Action[] = [
  { to: '/play', icon: 'Rocket', label: 'Play Space Blasters', primary: true },
  { to: '/practice', icon: 'Target', label: 'Practice math' },
  { to: '/progress', icon: 'TrendingUp', label: 'View progress' },
]

// Three big, real navigation tiles. Each is a comfortable tap target and links
// to a route that already exists.
export function QuickActions() {
  return (
    <Panel className="flex h-full flex-col gap-4">
      <h2 className="text-lg font-semibold text-foreground">Quick actions</h2>
      <ul className="flex flex-col gap-3">
        {ACTIONS.map((a) => (
          <li key={a.to}>
            <Link
              to={a.to}
              className={cn(
                'flex min-h-16 items-center gap-3 rounded-xl border px-4 font-semibold transition-colors',
                a.primary
                  ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'border-border bg-card text-foreground hover:bg-surface-muted',
              )}
            >
              <span
                className={cn(
                  'inline-grid size-10 shrink-0 place-items-center rounded-xl',
                  a.primary ? 'bg-white/20 text-primary-foreground' : 'bg-primary-soft text-primary',
                )}
              >
                <Icon name={a.icon} size={20} />
              </span>
              {a.label}
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
