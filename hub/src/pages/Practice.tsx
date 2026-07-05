import { Link } from 'react-router-dom'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// Honest empty state: no fake questions or scoring. The one real action is to
// go play the live game, where the actual math practice happens today.
export default function Practice() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Practice Math</h1>

      <Panel className="mt-6 flex flex-col items-start gap-4">
        <div className="flex w-full items-start justify-between gap-4">
          <span className="inline-grid size-12 place-items-center rounded-xl bg-primary-soft text-primary">
            <Icon name="Target" size={24} />
          </span>
          <Badge variant="outline" className="border-border text-muted-foreground">
            Coming soon
          </Badge>
        </div>
        <p className="max-w-prose text-foreground">
          Practice sets are coming soon. For now, the best practice is inside Space Blasters.
        </p>
        <Button asChild className="mt-2 h-12 rounded-full px-6 text-base font-semibold">
          <Link to="/play">Play Space Blasters</Link>
        </Button>
      </Panel>
    </div>
  )
}
