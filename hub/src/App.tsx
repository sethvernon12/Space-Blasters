import { Link, Outlet } from 'react-router-dom'
import { useAuth } from './lib/auth'
import SignIn from './pages/SignIn'
import { Sidebar } from '@/components/Sidebar'
import { MobileNav } from '@/components/MobileNav'
import { Icon } from '@/components/Icon'
import { HUB_NAME } from './lib/config'

export default function App() {
  const { account } = useAuth()

  // Auth gate — unchanged. Everything below is the signed-in app shell.
  if (!account) return <SignIn />

  return (
    <div className="min-h-dvh bg-background">
      {/* Fixed desktop rail (240px), hidden below md. */}
      <Sidebar />

      {/* Content column sits to the right of the rail at md+. */}
      <div className="flex min-h-dvh flex-col md:pl-60">
        {/* Mobile top bar — visible only below md. */}
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-card/90 px-2 py-2 backdrop-blur-sm md:hidden">
          <MobileNav />
          <Link
            to="/"
            aria-label={`${HUB_NAME} — home`}
            className="flex min-h-11 items-center gap-2 pr-2"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gold-soft text-warning-text">
              <Icon name="GraduationCap" size={18} />
            </span>
            <span className="text-base font-bold text-foreground">
              {HUB_NAME}
            </span>
          </Link>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
