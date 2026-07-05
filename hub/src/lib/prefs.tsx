import { createContext, useContext, useEffect, useMemo, useState } from 'react'

// User preferences persisted locally (device-scoped). No PII, no network.
export interface Prefs {
  readAloud: boolean          // show read-aloud (text-to-speech) affordances
  readingFont: boolean        // Lexend dyslexia-friendly font
}

interface PrefsContext extends Prefs {
  setReadAloud: (v: boolean) => void
  setReadingFont: (v: boolean) => void
}

const KEY = 'sg_hub_prefs'
const Ctx = createContext<PrefsContext | null>(null)

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (raw && typeof raw === 'object')
      return { readAloud: !!raw.readAloud, readingFont: !!raw.readingFont }
  } catch { /* ignore */ }
  return { readAloud: false, readingFont: false }
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load)

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
    document.documentElement.dataset.readingFont = prefs.readingFont ? 'lexend' : 'inter'
  }, [prefs])

  const value = useMemo<PrefsContext>(() => ({
    ...prefs,
    setReadAloud: (v) => setPrefs((p) => ({ ...p, readAloud: v })),
    setReadingFont: (v) => setPrefs((p) => ({ ...p, readingFont: v })),
  }), [prefs])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePrefs(): PrefsContext {
  const c = useContext(Ctx)
  if (!c) throw new Error('usePrefs must be used inside <PreferencesProvider>.')
  return c
}
