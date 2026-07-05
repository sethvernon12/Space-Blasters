import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/ui/badge'

// Placeholder only — honest empty state, no fabricated messages.
export default function Messages() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Messages</h1>

      <Panel className="mt-6 flex flex-col items-start gap-4">
        <div className="flex w-full items-start justify-between gap-4">
          <span className="inline-grid size-12 place-items-center rounded-xl bg-primary-soft text-primary">
            <Icon name="MessageCircle" size={24} />
          </span>
          <Badge variant="outline" className="border-border text-muted-foreground">
            Coming soon
          </Badge>
        </div>
        <p className="max-w-prose text-foreground">
          No messages yet. This is where notes from your parent or teacher will appear.
        </p>
      </Panel>
    </div>
  )
}
