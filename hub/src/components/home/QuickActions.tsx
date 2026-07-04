import { Link } from 'react-router-dom'
import { Panel } from '@/components/Panel'
import { Icon, type IconName } from '@/components/Icon'

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
        {ACTIONS.map((a) =>
          a.primary ? (
            // HERO: the primary way in. Taller, richer, and lifted so Play is
            // unmistakably the main action on the home.
            <li key={a.to}>
              <Link
                to={a.to}
                className="flex min-h-20 items-center gap-4 rounded-2xl border border-transparent bg-primary px-5 py-4 font-semibold text-primary-foreground shadow-card ring-1 ring-inset ring-white/10 transition-colors hover:bg-primary/90"
              >
                <span className="inline-grid size-14 shrink-0 place-items-center rounded-xl bg-white/20 text-primary-foreground">
                  <Icon name={a.icon} size={28} />
                </span>
                <span className="flex flex-col">
                  <span className="text-lg">{a.label}</span>
                  <span className="text-sm font-normal text-primary-foreground/85">
                    Say, tap, or type your answer
                  </span>
                </span>
              </Link>
            </li>
          ) : (
            <li key={a.to}>
              <Link
                to={a.to}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-border bg-card px-4 font-semibold text-foreground transition-colors hover:bg-surface-muted"
              >
                <span className="inline-grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
                  <Icon name={a.icon} size={20} />
                </span>
                {a.label}
              </Link>
            </li>
          ),
        )}
      </ul>
    </Panel>
  )
}
