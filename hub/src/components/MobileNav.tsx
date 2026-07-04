import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { NAV } from '@/lib/nav'
import { HUB_NAME } from '@/lib/config'
import { Icon, type IconName } from '@/components/Icon'
import { ProfileChip } from '@/components/ProfileChip'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

// The mobile drawer. Opened by the hamburger in App's top bar; mirrors the
// desktop sidebar nav and closes itself whenever the route changes.
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()

  // Close the sheet after navigating.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Open menu"
          className="size-12 text-foreground"
        >
          <Icon name="Menu" size={24} />
        </Button>
      </SheetTrigger>

      <SheetContent
        side="left"
        className="w-72 border-r border-border bg-card p-0"
      >
        <SheetHeader className="p-5 pb-3">
          <SheetTitle className="sr-only">Main menu</SheetTitle>
          <div className="flex items-center gap-3">
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
        </SheetHeader>

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
      </SheetContent>
    </Sheet>
  )
}
