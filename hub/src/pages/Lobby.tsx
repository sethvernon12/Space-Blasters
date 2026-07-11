import { useState } from 'react'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import type { Profile } from '@/lib/session'

// The zero-privilege LOBBY: where every brand-new signed-in adult lands. It holds
// NO access to any child — being trusted with children is a separate, later step.
// It offers TWO never-mixed paths, both presented but not yet functional-complete:
//   * Academy  → acceptance-key redemption (wired in AR-4)
//   * Homeschool → self-serve family setup (wired in AR-3)
// This slice (AR-2) is the lobby + the first-run router only; the paths are honest
// previews that confer nothing.
export default function Lobby({ profile }: { profile: Profile }) {
  const [path, setPath] = useState<null | 'academy' | 'homeschool'>(null)
  const [key, setKey] = useState('')

  return (
    <div className="flex flex-col gap-5" data-testid="lobby">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Welcome, {profile.displayName || 'friend'} 👋</h1>
        <p className="text-sm text-muted-foreground">Let’s get you set up.</p>
      </div>

      {/* honest zero-privilege statement */}
      <Panel className="flex items-start gap-3" style={{ background: 'var(--gold-soft)' }}>
        <span className="mt-0.5 shrink-0 text-warning-text"><Icon name="Sparkles" size={18} /></span>
        <p className="text-sm text-warning-text">
          You’re signed in, but your account isn’t set up yet — so there’s nothing here to see.
          You don’t have access to any child’s learning space. Choose how you’d like to begin.
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* ---- Academy arena ---- */}
        <Panel className="flex flex-col gap-3" data-testid="lobby-academy">
          <span className="grid size-11 place-items-center rounded-2xl bg-primary-soft text-primary"><Icon name="GraduationCap" size={24} /></span>
          <div>
            <h2 className="text-base font-bold text-foreground">Joining through an Academy</h2>
            <p className="mt-1 text-sm text-muted-foreground">Your Academy invited you or your family. Enter the acceptance key they gave you.</p>
          </div>
          {path === 'academy' ? (
            <div className="flex flex-col gap-2">
              <input value={key} onChange={(e) => setKey(e.target.value)} maxLength={64} placeholder="Acceptance key" aria-label="Academy acceptance key"
                data-testid="lobby-academy-key" className="min-h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-border-strong" />
              {/* inert until AR-4 wires real Academy-controlled key redemption */}
              <button type="button" data-testid="lobby-academy-continue" disabled aria-disabled="true"
                className="min-h-10 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground opacity-50">Continue</button>
              <p className="text-xs text-muted-foreground" role="status">Academy sign-up is being set up — key redemption opens soon. Your Academy will confirm your invitation.</p>
            </div>
          ) : (
            <button type="button" data-testid="lobby-academy-open" onClick={() => setPath('academy')}
              className="mt-auto flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border-strong bg-card text-sm font-semibold text-foreground hover:bg-surface-muted">
              I have an acceptance key <Icon name="ArrowRight" size={15} />
            </button>
          )}
        </Panel>

        {/* ---- Homeschool arena ---- */}
        <Panel className="flex flex-col gap-3" data-testid="lobby-homeschool">
          <span className="grid size-11 place-items-center rounded-2xl text-warning-text" style={{ background: 'var(--gold-soft)' }}><Icon name="Users" size={24} /></span>
          <div>
            <h2 className="text-base font-bold text-foreground">Homeschooling on your own</h2>
            <p className="mt-1 text-sm text-muted-foreground">Set up your own family space and add your first learner — you stay fully in control.</p>
          </div>
          {path === 'homeschool' ? (
            <p className="mt-auto rounded-xl border border-border p-3 text-sm text-muted-foreground" role="status" data-testid="lobby-homeschool-note">
              Homeschool setup opens next — we’ll walk you through adding your first learner and consent. Hang tight!
            </p>
          ) : (
            <button type="button" data-testid="lobby-homeschool-open" onClick={() => setPath('homeschool')}
              className="mt-auto flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-border-strong bg-card text-sm font-semibold text-foreground hover:bg-surface-muted">
              Set up my homeschool <Icon name="ArrowRight" size={15} />
            </button>
          )}
        </Panel>
      </div>

      <p className="text-center text-xs text-muted-foreground">Not sure yet? You can sign out from the menu and come back anytime.</p>
    </div>
  )
}
