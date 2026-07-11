import type { ReactNode } from 'react'
import { Crest } from '@/components/Crest'
import { HUB_MOTTO } from '@/lib/config'
import { AccountMenu } from '@/components/AccountMenu'

// The signed-in shell: a slim top bar (brand → home + the account menu) over a
// centered content column. Responsive, touch-first (44px+ targets).
export function RoleShell({ role, name, onNavigate, children }: { role: string; name: string; onNavigate: (v: 'home' | 'account') => void; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2.5 border-b border-border bg-card/90 px-4 py-2.5 backdrop-blur-sm">
        <button type="button" onClick={() => onNavigate('home')} aria-label="All-Around Athlete Academy — home" className="flex min-w-0 items-center gap-2.5 text-left">
          <Crest size={30} className="shrink-0" />
          <span className="flex min-w-0 flex-col leading-[1.06]">
            {/* mobile: short two-line stack; sm+: full wordmark on one line */}
            <span className="text-[13px] font-black tracking-tight text-foreground sm:hidden">All-Around<br />Athlete Academy</span>
            <span className="hidden text-sm font-black tracking-tight text-foreground sm:inline">All-Around Athlete Academy</span>
            <span className="mt-0.5 hidden text-[11px] font-medium text-muted-foreground sm:block">{HUB_MOTTO}</span>
          </span>
        </button>
        <div className="ml-auto">
          <AccountMenu role={role} name={name} onNavigate={onNavigate} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
