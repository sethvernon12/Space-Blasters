import { useState } from 'react'
import { Crest } from '@/components/Crest'
import { HUB_MOTTO } from '@/lib/config'
import { supabase } from '@/lib/supabase'

// Real sign-in surface for builds without the dev switcher (VITE_ALLOW_DEV_SIGNIN
// unset). Adults sign in with Google (server-side flow via Supabase Auth — no
// client id/secret here). Children never sign in here; they enter only through
// the parent-authorized mint (Slice 2). Verifiable-parental-consent at signup
// lands in Phase 3.5.
export default function SignIn() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function signIn() {
    setBusy(true)
    setErr(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    // on success the browser redirects to Google; only reached on error
    if (error) { setErr(error.message); setBusy(false) }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-xs text-center">
        <div className="flex justify-center"><Crest size={52} /></div>
        <h1 className="mt-3 text-lg font-black tracking-tight text-foreground">The All-Around Athlete Academy</h1>
        <p className="mt-1 text-sm text-muted-foreground">{HUB_MOTTO}</p>
        <button
          type="button"
          onClick={signIn}
          disabled={busy}
          className="mt-5 min-h-11 w-full rounded-full bg-primary px-4 font-bold text-primary-foreground disabled:opacity-60"
        >
          {busy ? 'Redirecting…' : 'Sign in with Google'}
        </button>
        {err && <p className="mt-2 text-sm font-medium" style={{ color: 'var(--danger)' }}>{err}</p>}
        <p className="mt-3 text-xs text-muted-foreground">Parents &amp; tutors sign in here. A child enters through their parent.</p>
      </div>
    </div>
  )
}
