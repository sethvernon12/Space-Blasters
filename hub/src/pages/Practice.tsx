import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { GAME_URL } from '../lib/config'

export default function Practice() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-[#dfe9ff]">Practice Math</h1>
      <Card className="mt-6 flex flex-col items-start gap-4 border-border bg-card p-6 sm:p-8">
        <div className="flex w-full items-start justify-between gap-4">
          <span aria-hidden="true" className="text-4xl">
            ✏️
          </span>
          <Badge variant="outline" className="border-border text-hud">
            Coming soon
          </Badge>
        </div>
        <p className="max-w-prose text-[#dfe9ff]">
          Practice sets are coming soon. For now, the best practice is inside
          Space Blasters.
        </p>
        <Button asChild className="mt-2 h-12 px-6 text-base font-semibold">
          <a href={GAME_URL}>Play Space Blasters</a>
        </Button>
      </Card>
    </div>
  )
}
