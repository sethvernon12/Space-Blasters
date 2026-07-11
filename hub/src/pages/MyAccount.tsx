import { useState } from 'react'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { DeleteAccountDialog } from '@/components/DeleteAccountDialog'
import { useSession, type Profile } from '@/lib/session'

const ROLE_LABEL: Record<string, string> = { parent: 'Parent', child: 'Learner', tutor: 'Tutor' }

// The account home: who you're signed in as, a plainly-labeled sign-out, and —
// for a parent (the account owner) — the relocated "Delete my account". A child
// session is a parent's mint, so it returns to the parent instead of signing out
// and never sees account deletion.
export default function MyAccount({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const { signOut, returnToParent } = useSession()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const isChild = profile.role === 'child'
  const isParent = profile.role === 'parent'
  const initial = profile.displayName.trim().charAt(0).toUpperCase() || '?'
  // a child's "email" is an opaque @child.invalid identity — never surfaced
  const showEmail = !isChild && !!profile.email && !profile.email.endsWith('@child.invalid')

  return (
    <div className="flex flex-col gap-5">
      <button type="button" onClick={onBack} className="flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <Icon name="ArrowLeft" size={16} /> Back
      </button>

      <h1 className="text-2xl font-bold text-foreground">My account</h1>

      <Panel className="flex items-center gap-4">
        <Avatar size="lg" className="shrink-0">
          <AvatarFallback className="bg-primary-soft text-lg font-semibold text-primary">{initial}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-lg font-bold text-foreground" data-testid="account-name">{profile.displayName || 'You'}</p>
          {showEmail && <p className="truncate text-sm text-muted-foreground" data-testid="account-email">{profile.email}</p>}
          <p className="mt-0.5 text-sm text-muted-foreground">{ROLE_LABEL[profile.role] ?? profile.role}</p>
        </div>
      </Panel>

      <Panel className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{isChild ? 'Return to parent' : 'Sign out'}</p>
          <p className="text-xs text-muted-foreground">{isChild ? 'Go back to the parent’s hub on this device.' : 'End your session on this device.'}</p>
        </div>
        <button type="button" data-testid={isChild ? 'return-to-parent' : 'sign-out'} onClick={isChild ? returnToParent : signOut}
          className="flex min-h-10 shrink-0 items-center gap-2 rounded-full border border-border-strong bg-card px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">
          <Icon name={isChild ? 'ArrowLeft' : 'LogOut'} size={16} /> {isChild ? 'Return to parent' : 'Sign out'}
        </button>
      </Panel>

      {/* Danger zone — the account owner (parent) only. A child never sees it. */}
      {isParent && (
        <div className="mt-2 rounded-2xl border border-dashed p-4" style={{ borderColor: 'var(--danger, #c0392b)' }}>
          <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--danger, #c0392b)' }}>Danger zone</p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Delete your account and every child’s records permanently.</p>
            <button type="button" data-testid="delete-account" onClick={() => setDeleteOpen(true)}
              className="min-h-9 shrink-0 rounded-full border px-4 text-sm font-semibold" style={{ borderColor: 'var(--danger, #c0392b)', color: 'var(--danger, #c0392b)' }}>
              Delete my account
            </button>
          </div>
        </div>
      )}

      {deleteOpen && (
        <DeleteAccountDialog childCount={profile.children.length}
          onClose={() => setDeleteOpen(false)} onDone={() => void signOut()} />
      )}
    </div>
  )
}
