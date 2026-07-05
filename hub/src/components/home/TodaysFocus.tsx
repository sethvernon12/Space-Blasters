import { Link } from 'react-router-dom'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/ui/button'

// Today's focus. There is no recommendation engine yet, so we show an honest
// empty state rather than inventing a "recommended skill". The shape below
// leaves room for a future getNextActivity() to slot a real recommendation in.
export function TodaysFocus() {
  const recommendation = null // getNextActivity() — not wired yet

  return (
    <Panel className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="inline-grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
          <Icon name="Target" size={20} />
        </span>
        <h2 className="text-lg font-semibold text-foreground">Today's focus</h2>
      </div>

      {recommendation ? null : (
        <div className="flex flex-1 flex-col items-start gap-4">
          <p className="text-muted-foreground">
            Start practicing to see your focus here.
          </p>
          <Button asChild className="mt-auto min-h-12 px-5">
            <Link to="/practice">
              <Icon name="Sparkles" size={18} />
              Start practicing
            </Link>
          </Button>
        </div>
      )}
    </Panel>
  )
}
