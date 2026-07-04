import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/ui/button'
import { verseOfTheDay } from '@/data/verses'
import { usePrefs } from '@/lib/prefs'
import { speak, ttsSupported } from '@/lib/tts'

// Verse of the day — a calm, faith-centered accent. A gold-tinted icon chip
// keeps it warm without shouting. Read-aloud only appears when the pref is on
// AND the browser supports speech synthesis.
export function VerseCard() {
  const { text, reference } = verseOfTheDay()
  const { readAloud } = usePrefs()
  const canRead = readAloud && ttsSupported()

  return (
    <Panel className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="inline-grid size-10 shrink-0 place-items-center rounded-xl bg-gold-soft text-warning-text">
          <Icon name="BookOpen" size={20} />
        </span>
        <h2 className="text-lg font-semibold text-foreground">Verse of the day</h2>
      </div>

      <blockquote className="text-lg leading-relaxed text-foreground">
        “{text}”
      </blockquote>
      <p className="font-medium text-muted-foreground">{reference}</p>

      {canRead && (
        <div className="mt-auto pt-1">
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => speak(`${text} — ${reference}`)}
          >
            <Icon name="Volume2" size={18} />
            Read aloud
          </Button>
        </div>
      )}
    </Panel>
  )
}
