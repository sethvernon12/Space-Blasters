import { useEffect, useRef, useState } from 'react'
import { useSession } from '@/lib/session'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Icon } from '@/components/Icon'

const ROLE_LABEL: Record<string, string> = { parent: 'Parent', child: 'Learner', tutor: 'Tutor', lobby: 'Getting started' }

// The signed-in account menu in the shell header: real name + role, opening a
// small menu with "My account" and a plainly-labeled "Sign out". A child session
// is always a parent's mint, so it "Returns to parent" instead of signing out.
export function AccountMenu({ role, name, onNavigate }: { role: string; name: string; onNavigate: (v: 'home' | 'account') => void }) {
  const { signOut, returnToParent } = useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isChild = role === 'child'
  const initial = name.trim().charAt(0).toUpperCase() || '?'

  // while open: land keyboard focus on the first item, close on outside click or
  // Escape (Escape returns focus to the trigger).
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const pick = (fn: () => void) => { setOpen(false); fn() }

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="account-menu"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-9 items-center gap-2 rounded-full border border-border-strong bg-card py-1 pl-1 pr-2.5 text-left transition-colors hover:bg-surface-muted"
      >
        <Avatar size="sm" className="shrink-0">
          <AvatarFallback className="bg-primary-soft text-xs font-semibold text-primary">{initial}</AvatarFallback>
        </Avatar>
        <span className="hidden min-w-0 flex-col leading-tight sm:flex">
          <span className="max-w-[10rem] truncate text-sm font-semibold text-foreground">{name}</span>
          <span className="text-xs text-muted-foreground">{ROLE_LABEL[role] ?? role}</span>
        </span>
        <Icon name="ChevronDown" size={15} />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-card">
          {/* name+role header on small screens where the trigger hides them */}
          <div className="border-b border-border px-3 py-2 sm:hidden">
            <p className="truncate text-sm font-semibold text-foreground">{name}</p>
            <p className="text-xs text-muted-foreground">{ROLE_LABEL[role] ?? role}</p>
          </div>
          <button type="button" role="menuitem" data-testid="nav-my-account" onClick={() => pick(() => onNavigate('account'))}
            className="flex min-h-11 w-full items-center gap-2.5 px-3 text-sm font-medium text-foreground outline-none hover:bg-surface-muted focus:bg-surface-muted">
            <Icon name="UserRound" size={16} /> My account
          </button>
          {isChild ? (
            <button type="button" role="menuitem" data-testid="return-to-parent" onClick={() => pick(returnToParent)}
              className="flex min-h-11 w-full items-center gap-2.5 px-3 text-sm font-medium text-foreground outline-none hover:bg-surface-muted focus:bg-surface-muted">
              <Icon name="ArrowLeft" size={16} /> Return to parent
            </button>
          ) : (
            <button type="button" role="menuitem" data-testid="sign-out" onClick={() => pick(signOut)}
              className="flex min-h-11 w-full items-center gap-2.5 px-3 text-sm font-medium text-foreground outline-none hover:bg-surface-muted focus:bg-surface-muted">
              <Icon name="LogOut" size={16} /> Sign out
            </button>
          )}
        </div>
      )}
    </div>
  )
}
