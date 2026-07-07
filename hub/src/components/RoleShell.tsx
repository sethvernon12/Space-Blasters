import type { ReactNode } from 'react'
import { useSession } from '@/lib/session'
import { Icon } from '@/components/Icon'
import { Crest } from '@/components/Crest'
import { HUB_MOTTO } from '@/lib/config'

const ROLE_LABEL: Record<string, string> = { parent: 'Parent', child: 'Learner', tutor: 'Tutor' }

// The signed-in shell: a slim top bar (brand + who + switch) over a centered
// content column. Responsive, touch-first (44px+ targets).
export function RoleShell({ role, name, children }: { role: string; name: string; children: ReactNode }) {
  const { signOut } = useSession()
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2.5 border-b border-border bg-card/90 px-4 py-2.5 backdrop-blur-sm">
        <Crest size={30} />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-black tracking-tight text-foreground">All-Around Athlete Academy</span>
          <span className="hidden text-[11px] font-medium text-muted-foreground sm:block">{HUB_MOTTO}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="flex flex-col items-end leading-tight">
            <span className="text-sm font-semibold text-foreground">{name}</span>
            <span className="text-xs text-muted-foreground">{ROLE_LABEL[role] ?? role}</span>
          </span>
          <button
            type="button"
            onClick={signOut}
            className="flex min-h-9 items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted"
          >
            <Icon name="Repeat" size={15} /> Switch
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
