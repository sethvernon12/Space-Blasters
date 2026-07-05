import type { ReactNode } from 'react'
import { Panel } from '@/components/Panel'
import { Label } from '@/components/ui/label'
import { usePrefs } from '@/lib/prefs'
import { ttsSupported } from '@/lib/tts'
import { cn } from '@/lib/utils'

// An accessible switch: a real button with role="switch" + aria-checked, a
// palette-tinted track/thumb, a >=48px touch area, and visible focus. Keyboard
// operable for free (it's a native <button>). The whole row is clickable.
function Switch({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-surface-muted',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block size-6 rounded-full bg-card shadow-card transition-transform',
          checked ? 'translate-x-7' : 'translate-x-1',
        )}
      />
    </button>
  )
}

function SettingRow({
  id,
  title,
  description,
  control,
}: {
  id: string
  title: string
  description: ReactNode
  control: ReactNode
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-1">
      <div className="flex-1">
        <Label htmlFor={id} className="text-base font-medium text-foreground">
          {title}
        </Label>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {control}
    </div>
  )
}

export default function Settings() {
  const { readAloud, readingFont, setReadAloud, setReadingFont } = usePrefs()
  const canSpeak = ttsSupported()

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Settings</h1>

      <Panel className="mt-6 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Reading &amp; accessibility</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Saved on this device.</p>
        </div>

        <SettingRow
          id="pref-read-aloud"
          title="Read aloud"
          description={
            canSpeak
              ? 'Show read-aloud buttons around the app.'
              : 'Not available in this browser.'
          }
          control={
            <Switch
              id="pref-read-aloud"
              checked={canSpeak && readAloud}
              onChange={setReadAloud}
              disabled={!canSpeak}
              label="Read aloud"
            />
          }
        />

        <SettingRow
          id="pref-reading-font"
          title="Reading font (Lexend)"
          description="A dyslexia-friendly font for the whole hub."
          control={
            <Switch
              id="pref-reading-font"
              checked={readingFont}
              onChange={setReadingFont}
              label="Reading font (Lexend)"
            />
          }
        />
      </Panel>
    </div>
  )
}
