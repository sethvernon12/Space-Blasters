import { useState } from 'react'
import { DEV_ACCOUNTS, useSession } from '@/lib/session'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'

// LOCAL dev "Sign in as…" switcher. Real Google OAuth is deferred to the DEV
// promotion step (it can't be bot-tested locally).
export default function DevSignIn() {
  const { signInAs } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <Panel className="w-full max-w-md">
        <div className="flex flex-col items-center text-center">
          <span className="inline-grid size-12 place-items-center rounded-xl bg-gold-soft text-warning-text">
            <Icon name="GraduationCap" size={26} />
          </span>
          <h1 className="mt-3 text-2xl font-bold text-foreground">Smarter Games</h1>
          <p className="text-sm text-muted-foreground">Family hub — choose who’s signing in</p>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          {DEV_ACCOUNTS.map((a) => (
            <button
              key={a.email}
              type="button"
              disabled={busy !== null}
              onClick={async () => { setErr(null); setBusy(a.email); const e = await signInAs(a.email); if (e) { setErr(e); setBusy(null) } }}
              className="flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-surface-muted disabled:opacity-60"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gold-soft text-warning-text">
                <Icon name={a.icon} size={22} />
              </span>
              <span className="flex-1">
                <span className="block text-base font-bold text-foreground">{a.label}</span>
                <span className="block text-sm text-muted-foreground">{a.sub}</span>
              </span>
              <Icon name={busy === a.email ? 'Loader' : 'ChevronRight'} size={20} />
            </button>
          ))}
        </div>

        {err && <p role="alert" className="mt-4 text-center text-sm font-medium text-[color:var(--danger)]">{err}</p>}
        <p className="mt-5 text-center text-xs text-muted-foreground">Local development · Google sign-in arrives at promotion</p>
      </Panel>
    </div>
  )
}
