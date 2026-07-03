import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export interface HubAccount {
  name: string
  pin: string
}

interface SignInResult {
  ok: boolean
  error?: string
}

interface AuthContextValue {
  account: HubAccount | null
  signIn: (name: string, pin: string) => Promise<SignInResult>
  signOut: () => void
}

// Hub-specific storage key — deliberately NOT the game's 'mb_account'.
const STORAGE_KEY = 'sg_hub_account'

const OFFLINE_ERROR =
  'Can’t reach the star base right now. Check your internet and try again.'
const MISMATCH_ERROR =
  'That name and PIN don’t match. Check them and try again.'

const AuthContext = createContext<AuthContextValue | null>(null)

function loadStoredAccount(): HubAccount | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as HubAccount).name === 'string' &&
      typeof (parsed as HubAccount).pin === 'string'
    ) {
      const { name, pin } = parsed as HubAccount
      return { name, pin }
    }
  } catch {
    // Corrupt JSON or unavailable storage — treat as signed out.
  }
  return null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Lazy initializer hydrates from localStorage exactly once, on mount.
  const [account, setAccount] = useState<HubAccount | null>(loadStoredAccount)

  const signIn = useCallback(
    async (name: string, pin: string): Promise<SignInResult> => {
      const trimmed = name.trim()
      if (!trimmed) {
        return { ok: false, error: 'Enter your pilot name to launch.' }
      }
      if (trimmed.length > 18) {
        return {
          ok: false,
          error: 'Pilot names can be 18 characters at most.',
        }
      }
      if (!/^[0-9]{4}$/.test(pin)) {
        return {
          ok: false,
          error: 'Your PIN is exactly 4 digits, numbers only.',
        }
      }

      // v1 auth reuses the game's existing account RPC — the only network
      // endpoint in the whole hub.
      try {
        const res = await fetch(
          `${__SUPABASE_URL__}/rest/v1/rpc/signup_or_login`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: __SUPABASE_PUBLISHABLE_KEY__,
              Authorization: `Bearer ${__SUPABASE_PUBLISHABLE_KEY__}`,
            },
            body: JSON.stringify({ p_name: trimmed, p_pin: pin }),
          },
        )
        if (!res.ok) return { ok: false, error: OFFLINE_ERROR }

        const json = (await res.json()) as { ok?: boolean; error?: string }
        if (json.ok !== true) {
          return { ok: false, error: json.error || MISMATCH_ERROR }
        }

        const next: HubAccount = { name: trimmed, pin }
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        } catch {
          // Storage full/blocked — still signed in for this session.
        }
        setAccount(next)
        return { ok: true }
      } catch {
        return { ok: false, error: OFFLINE_ERROR }
      }
    },
    [],
  )

  const signOut = useCallback(() => {
    setAccount(null)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Storage unavailable — state is cleared regardless.
    }
  }, [])

  const value = useMemo(
    () => ({ account, signIn, signOut }),
    [account, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used inside an <AuthProvider>.')
  }
  return ctx
}
