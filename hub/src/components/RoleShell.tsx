import type { ReactNode } from 'react'
import { useSession } from '@/lib/session'
import { Icon } from '@/components/Icon'
import { HUB_NAME } from '@/lib/config'

const ROLE_LABEL: Record<string, string> = { parent: 'Parent', child: 'Learner', tutor: 'Tutor' }

// The signed-in shell: a slim top bar (brand + who + switch) over a centered
// content column. Responsive, touch-first (44px+ targets).
export function RoleShell({ role, name, children }: { role: string; name: string; children: ReactNode }) {
  const { signOut } = useSession()
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-card/90 px-4 py-2.5 backdrop-blur-sm">
        <span className="flex size-8 items-center justify-center rounded-lg bg-gold-soft text-warning-text">
          <Icon name="GraduationCap" size={18} />
        </span>
        <span className="text-base font-bold text-foreground">{HUB_NAME}</span>
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
