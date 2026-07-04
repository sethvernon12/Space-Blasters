import { useAuth } from '@/lib/auth'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/Icon'

// The signed-in pilot, shown at the foot of the sidebar and mobile menu.
// The session only carries { name, pin } — there is deliberately no grade,
// streak, or status here. We never invent one.
export function ProfileChip() {
  const { account, signOut } = useAuth()
  if (!account) return null

  const initial = account.name.trim().charAt(0).toUpperCase() || '?'

  return (
    <div className="rounded-xl bg-surface-muted p-2">
      <div className="flex items-center gap-2.5 px-1 py-1">
        <Avatar size="sm" className="shrink-0">
          <AvatarFallback className="bg-primary-soft font-semibold text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground" title={account.name}>
            {account.name}
          </p>
          <p className="text-xs text-muted-foreground">Pilot</p>
        </div>
      </div>
      <Button
        variant="ghost"
        onClick={signOut}
        className="mt-1 min-h-11 w-full justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
      >
        <Icon name="LogOut" size={16} />
        Sign out
      </Button>
    </div>
  )
}
