import { Crest } from '@/components/Crest'
import { HUB_MOTTO } from '@/lib/config'

// Real sign-in surface for builds without the dev switcher (VITE_ALLOW_DEV_SIGNIN
// unset). Google OAuth + verifiable-parental-consent-at-signup land here in
// Phase 3 (SEC-08c / RM-12); until then this is a deliberate placeholder so a
// non-staging build has no synthetic-account impersonation path.
export default function SignIn() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-xs text-center">
        <div className="flex justify-center"><Crest size={52} /></div>
        <h1 className="mt-3 text-lg font-black tracking-tight text-foreground">The All-Around Athlete Academy</h1>
        <p className="mt-1 text-sm text-muted-foreground">{HUB_MOTTO}</p>
        <button
          type="button"
          disabled
          className="mt-5 min-h-11 w-full cursor-not-allowed rounded-full bg-primary px-4 font-bold text-primary-foreground opacity-60"
        >
          Sign in with Google
        </button>
        <p className="mt-3 text-xs text-muted-foreground">Coming soon — secure family sign-in with parental consent.</p>
      </div>
    </div>
  )
}
