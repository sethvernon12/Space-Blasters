import { useState, type FormEvent } from 'react'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="starfield" aria-hidden="true" />
      <Card className="relative z-10 w-full max-w-sm">
        <CardHeader className="text-center">
          <h1 className="wordmark text-2xl font-black tracking-widest">
            SMARTER GAMES
          </h1>
          <p className="text-sm text-hud">Math Mission Command</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="pilot-name">Pilot name</Label>
              <Input
                id="pilot-name"
                name="username"
                autoComplete="username"
                maxLength={18}
                placeholder="e.g. Nova"
                className="h-12 text-base"
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
                className="h-12 text-base"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm font-medium text-rose">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={pending}
              className="h-12 w-full text-base font-bold"
            >
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-hud">
            Use the same pilot name and 4-digit PIN as in Space Blasters. New
            here? Signing in creates your pilot.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
