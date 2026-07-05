import { NavLink } from 'react-router-dom'
import { NAV } from '@/lib/nav'
import { HUB_NAME } from '@/lib/config'
import { Icon, type IconName } from '@/components/Icon'
import { ProfileChip } from '@/components/ProfileChip'
import { cn } from '@/lib/utils'

// The fixed desktop rail. Hidden below `md` (the mobile menu mirrors it).
export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-card md:flex">
      <div className="flex items-center gap-3 px-5 py-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gold-soft text-warning-text">
          <Icon name="GraduationCap" size={22} />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-base font-bold text-foreground">
            {HUB_NAME}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            Math mission
          </span>
        </span>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-3">
        <ul className="flex flex-col gap-1">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm transition-colors',
                    isActive
                      ? 'bg-primary-soft font-semibold text-primary'
                      : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                  )
                }
              >
                <Icon name={item.icon as IconName} size={20} />
                <span className="truncate">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        <ProfileChip />
      </div>
    </aside>
  )
}
