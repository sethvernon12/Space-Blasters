import type { ReactNode } from 'react'
import { useSession } from '@/lib/session'
import { Icon } from '@/components/Icon'
import { Crest } from '@/components/Crest'
import { HUB_MOTTO } from '@/lib/config'

const ROLE_LABEL: Record<string, string> = { parent: 'Parent', child: 'Learner', tutor: 'Tutor' }

// The signed-in shell: a slim top bar (brand + who + switch) over a centered
// content column. Responsive, touch-first (44px+ targets).
export function RoleShell({ role, name, children }: { role: string; name: string; children: ReactNode }) {
  const { signOut, returnToParent } = useSession()
  // a child session only ever exists via a parent's mint → the action returns to
  // the parent; every other role signs out.
  const isChild = role === 'child'
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2.5 border-b border-border bg-card/90 px-4 py-2.5 backdrop-blur-sm">
        <Crest size={30} className="shrink-0" />
        <div className="flex min-w-0 flex-col leading-[1.06]">
          {/* mobile: short two-line stack; sm+: full wordmark on one line */}
          <span className="text-[13px] font-black tracking-tight text-foreground sm:hidden">All-Around<br />Athlete Academy</span>
          <span className="hidden text-sm font-black tracking-tight text-foreground sm:inline">All-Around Athlete Academy</span>
          <span className="mt-0.5 hidden text-[11px] font-medium text-muted-foreground sm:block">{HUB_MOTTO}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="flex flex-col items-end leading-tight">
            <span className="text-sm font-semibold text-foreground">{name}</span>
            <span className="text-xs text-muted-foreground">{ROLE_LABEL[role] ?? role}</span>
          </span>
          <button
            type="button"
            onClick={isChild ? returnToParent : signOut}
            className="flex min-h-9 items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted"
          >
            <Icon name={isChild ? 'ArrowLeft' : 'Repeat'} size={15} /> {isChild ? 'Return to parent' : 'Switch'}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
