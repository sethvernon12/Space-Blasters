import { useSession } from '@/lib/session'
import DevSignIn from '@/components/DevSignIn'
import { RoleShell } from '@/components/RoleShell'
import ParentHome from '@/pages/ParentHome'
import ChildHome from '@/pages/ChildHome'
import TutorHome from '@/pages/TutorHome'

export default function Root() {
  const { session, loading, profile } = useSession()
  if (!session) return <DevSignIn />
  if (loading || !profile) {
    return <div className="grid min-h-dvh place-items-center bg-background text-sm text-muted-foreground">Loading your hub…</div>
  }
  return (
    <RoleShell role={profile.role} name={profile.displayName}>
      {profile.role === 'parent' ? <ParentHome profile={profile} />
        : profile.role === 'child' ? <ChildHome profile={profile} />
          : <TutorHome profile={profile} />}
    </RoleShell>
  )
}
