import { useState, type ReactNode } from 'react'
import { Crest } from '@/components/Crest'

// A cheap, env-gated access gate for the non-public staging preview. When
// VITE_STAGING_GATE is set (staging only), the app is hidden behind a shared
// passphrase; unset (local dev / e2e / prod) it renders children immediately so
// nothing here affects normal runs. This is a soft gate — the real protections
// are synthetic-only data + noindex; the passphrase just keeps the URL private.
// (If the Vercel plan includes Deployment Protection we can switch to that.)
const GATE = (import.meta.env.VITE_STAGING_GATE as string | undefined) || ''
const KEY = 'aaa_staging_ok'

export function StagingGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState<boolean>(() => {
    if (!GATE) return true
    try { return localStorage.getItem(KEY) === '1' } catch { return false }
  })
  const [val, setVal] = useState('')
  const [err, setErr] = useState(false)
  if (ok) return <>{children}</>

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (val === GATE) { try { localStorage.setItem(KEY, '1') } catch { /* private mode */ } setOk(true) }
          else setErr(true)
        }}
        className="w-full max-w-xs text-center"
      >
        <div className="flex justify-center"><Crest size={52} /></div>
        <h1 className="mt-3 text-lg font-black tracking-tight text-foreground">The All-Around Athlete Academy</h1>
        <p className="mt-1 text-sm text-muted-foreground">Private preview — enter the access code to continue.</p>
        <input
          type="password"
          value={val}
          onChange={(e) => { setVal(e.target.value); setErr(false) }}
          aria-label="Access code"
          autoFocus
          className="mt-4 min-h-11 w-full rounded-xl border border-border bg-card px-3 text-center text-foreground outline-none focus:border-border-strong"
        />
        {err && <p className="mt-2 text-sm font-medium" style={{ color: 'var(--danger)' }}>Incorrect code</p>}
        <button type="submit" className="mt-3 min-h-11 w-full rounded-full bg-primary px-4 font-bold text-primary-foreground">Enter</button>
        <p className="mt-4 text-xs text-muted-foreground">Synthetic data only · not for real children</p>
      </form>
    </div>
  )
}
