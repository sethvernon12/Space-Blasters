import { useState, type FormEvent } from 'react'
import { useAuth } from '@/lib/auth'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// RESTYLE ONLY — the sign-in behavior is unchanged from before: same signIn
// call, same validation ownership (in useAuth), same noValidate form so the
// friendly role="alert" wins over native bubbles, same no-navigation-on-success
// (the app re-renders into the hub when the account is set).
export default function SignIn() {
  const { signIn } = useAuth()
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    const result = await signIn(name, pin)
    if (!result.ok) {
      setError(result.error ?? 'Something went wrong. Try again.')
      setPending(false)
    }
    // On success the provider sets the account and the app re-renders into
    // the hub — this screen unmounts, so no navigation (or cleanup) needed.
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <Panel className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <span className="inline-grid size-12 place-items-center rounded-xl bg-gold-soft text-warning-text">
            <Icon name="GraduationCap" size={26} />
          </span>
          <h1 className="mt-3 text-2xl font-bold text-foreground">Smarter Games</h1>
          <p className="text-sm text-muted-foreground">Math Mission Command</p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pilot-name">Pilot name</Label>
            <Input
              id="pilot-name"
              name="username"
              autoComplete="username"
              maxLength={18}
              placeholder="e.g. Nova"
              className="h-12 rounded-xl border-border bg-card text-base"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pilot-pin">4-digit PIN</Label>
            <Input
              id="pilot-pin"
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="current-password"
              placeholder="••••"
              className="h-12 rounded-xl border-border bg-card text-base"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm font-medium text-[color:var(--danger)]">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={pending}
            className="h-12 w-full rounded-full text-base font-bold"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Use the same pilot name and 4-digit PIN as in Space Blasters. New here? Signing in
          creates your pilot.
        </p>

        {/* "Just play" — no hub session required. This is a real top-level
            navigation to /play (the separately-built game), so it MUST be a
            plain <a>, never a react-router <Link>. */}
        <div className="mt-5 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs font-medium text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
        <a
          href="/play"
          className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full border border-border-strong bg-card text-base font-semibold text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none"
        >
          <span aria-hidden="true">▶</span> Just play Space Blasters
        </a>
      </Panel>
    </div>
  )
}
