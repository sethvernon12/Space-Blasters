import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/ui/badge'

// Honest empty state — no fabricated assignments.
export default function Assignments() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Assignments</h1>

      <Panel className="mt-6 flex flex-col items-start gap-4">
        <div className="flex w-full items-start justify-between gap-4">
          <span className="inline-grid size-12 place-items-center rounded-xl bg-primary-soft text-primary">
            <Icon name="ClipboardList" size={24} />
          </span>
          <Badge variant="outline" className="border-border text-muted-foreground">
            Coming soon
          </Badge>
        </div>
        <p className="max-w-prose text-foreground">
          No assignments yet. Soon your parent will be able to send you work here, and you'll see
          it the moment it lands.
        </p>
      </Panel>
    </div>
  )
}
