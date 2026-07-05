import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/ui/button'
import { GAME_URL } from '@/lib/config'

// This page LINKS OUT to the live game — it never embeds it. An iframe would
// break the game: it needs pointer lock, Web Audio, and the microphone, all of
// which require a top-level browsing context (a new tab), not a sandboxed frame.
export default function Play() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Play Space Blasters</h1>

      <Panel className="mt-6 flex flex-col items-start gap-4">
        <span className="inline-grid size-12 place-items-center rounded-xl bg-gold-soft text-warning-text">
          <Icon name="Rocket" size={24} />
        </span>
        <p className="max-w-prose text-foreground">
          Ready for the arcade? Space Blasters opens in a new tab so your calm hub stays right
          here. Blast math problems out of the sky — say, tap, or type your answer!
        </p>
        <Button asChild className="mt-2 h-12 rounded-full px-6 text-base font-semibold">
          <a href={GAME_URL} target="_blank" rel="noopener noreferrer">
            <Icon name="ExternalLink" size={18} />
            Launch Space Blasters
          </a>
        </Button>
        <p className="text-sm text-muted-foreground">Opens in a new tab.</p>
      </Panel>
    </div>
  )
}
