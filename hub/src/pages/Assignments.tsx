import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'

export default function Assignments() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-[#dfe9ff]">My Assignments</h1>
      <Card className="mt-6 flex flex-col items-start gap-4 border-border bg-card p-6 sm:p-8">
        <div className="flex w-full items-start justify-between gap-4">
          <span aria-hidden="true" className="text-4xl">
            📋
          </span>
          <Badge variant="outline" className="border-border text-hud">
            Coming soon
          </Badge>
        </div>
        <p className="max-w-prose text-[#dfe9ff]">
          Assignments aren't ready yet. Soon your parent will be able to send
          you work here, and you'll see it the moment it lands.
        </p>
      </Card>
    </div>
  )
}
