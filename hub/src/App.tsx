import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './lib/auth'
import SignIn from './pages/SignIn'
import { Button } from '@/components/ui/button'
import { HUB_NAME } from './lib/config'

export default function App() {
  const { account, signOut } = useAuth()
  const { pathname } = useLocation()

  if (!account) return <SignIn />

  return (
    <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 sm:px-6">
      <div className="starfield" aria-hidden="true" />
      <header className="relative z-10 flex items-center justify-between gap-3 py-4">
        <Link to="/" aria-label={`${HUB_NAME} — home`} className="flex min-h-12 items-center gap-2">
          <span aria-hidden="true" className="text-2xl">🚀</span>
          <span className="wordmark text-xl font-black tracking-widest sm:text-2xl">
            {HUB_NAME.toUpperCase()}
          </span>
        </Link>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <span
            className="flex min-h-12 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-sm font-bold text-cyan"
            aria-label={`Signed in as pilot ${account.name}`}
          >
            <span aria-hidden="true">🧑‍🚀</span>
            <span className="max-w-28 truncate">{account.name}</span>
          </span>
          <Button variant="outline" className="min-h-12 shrink-0" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      {pathname !== '/' && (
        <nav aria-label="Back" className="relative z-10 pb-2">
          <Button asChild variant="ghost" className="min-h-12 -ml-3 text-hud">
            <Link to="/">← Back to Hub</Link>
          </Button>
        </nav>
      )}
      <main className="relative z-10 flex-1 pb-10">
        <Outlet />
      </main>
    </div>
  )
}
