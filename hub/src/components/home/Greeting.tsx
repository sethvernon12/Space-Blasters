import { useAuth } from '@/lib/auth'
import { greetingFor, encouragementOfTheDay } from '@/data/greetings'
import { StreakChip } from './StreakChip'

// The top-of-page welcome. A lighter treatment (not a full Panel): a real h1,
// a warm encouragement line, and the honest streak chip. No fabricated name —
// falls back to a friendly "friend" when there is no account.
export function Greeting() {
  const { account } = useAuth()

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-foreground">
          {greetingFor()}, {account?.name ?? 'friend'}! <span aria-hidden="true">👋</span>
        </h1>
        <p className="mt-1 text-muted-foreground">{encouragementOfTheDay()}</p>
      </div>
      <div className="shrink-0">
        <StreakChip />
      </div>
    </div>
  )
}
