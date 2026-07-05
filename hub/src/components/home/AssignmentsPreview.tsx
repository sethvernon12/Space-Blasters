import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/ui/badge'

// Assignments. Parent-assigned work isn't built yet, so this is an honest empty
// state — nothing interactive that pretends to work.
export function AssignmentsPreview() {
  return (
    <Panel className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Assignments</h2>
        <Badge variant="secondary">Coming soon</Badge>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl bg-surface-muted px-4 py-8 text-center">
        <span className="inline-grid size-12 place-items-center rounded-xl bg-card text-muted-soft">
          <Icon name="ClipboardList" size={24} />
        </span>
        <p className="max-w-xs text-muted-foreground">
          No assignments yet. When your parent sends work, it'll show up here.
        </p>
      </div>
    </Panel>
  )
}
