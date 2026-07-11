import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { loadChildrenAndGrants, startChildSession, type ChildRow } from './api'

export type Role = 'parent' | 'child' | 'tutor' | 'lobby'

// The dev "Sign in as…" switcher is a LOCAL/synthetic-staging stand-in for real
// Google OAuth (Phase 3). It is gated behind an EXPLICIT build flag so it — and
// the synthetic accounts + shared password below — are dead-code-eliminated from
// any build without VITE_ALLOW_DEV_SIGNIN=true (i.e. never shipped to real
// families). A real build renders the OAuth SignIn placeholder instead.
export const ALLOW_DEV_SIGNIN = import.meta.env.VITE_ALLOW_DEV_SIGNIN === 'true'

// Gated so the emails + shared password tree-shake out when the flag is off.
export const DEV_ACCOUNTS = ALLOW_DEV_SIGNIN
  ? [
      { label: 'Seth', sub: 'Parent — Brielle & Theo', email: 'seth@local.test', icon: 'Users' },
      { label: 'Brielle', sub: 'Learner', email: 'brielle@local.test', icon: 'Rocket' },
      { label: 'Grandma Rose', sub: 'Tutor for Brielle', email: 'rose@local.test', icon: 'GraduationCap' },
      { label: 'Alex', sub: 'Brand-new — no setup yet', email: 'newcomer@local.test', icon: 'Sparkles' },
    ]
  : []
const PW = ALLOW_DEV_SIGNIN ? 'localtest123' : ''

export interface Profile { role: Role; uid: string; displayName: string; email: string; children: ChildRow[]; canWrite: Record<string, boolean>; removed?: boolean }

// The adult's REAL name from the Google profile, read from the live session's
// user_metadata (populated by Google at each OAuth sign-in) — never persisted by
// us. Empty for dev password accounts (they have no full_name). DISPLAY-ONLY: this
// label carries NO authorization weight (role derives from children/grants rows,
// never from metadata), so a self-edited name is harmless — it never gates access.
function googleFullName(meta: Record<string, unknown> | null | undefined): string {
  return String(meta?.full_name || meta?.name || meta?.given_name || '')
}

interface Ctx {
  session: Session | null
  loading: boolean
  profile: Profile | null
  signInAs: (email: string) => Promise<string | null>
  signOut: () => Promise<void>
  reauth: () => Promise<string | null>
  enterChild: (childId: string) => Promise<string | null>
  returnToParent: () => Promise<void>
  reloadProfile: () => Promise<void>
}
const SessionCtx = createContext<Ctx | null>(null)

async function loadProfile(uid: string, email: string, fullName: string): Promise<Profile> {
  const { children, grants, family } = await loadChildrenAndGrants()
  const canWrite: Record<string, boolean> = {}
  for (const g of grants) if (g.active) canWrite[g.child_id] = g.can_write
  // An adult sees their REAL Google name; fall back to the email local-part (dev
  // password accounts have no full_name). Computed fresh from the session, never a
  // stored app row.
  const label = ((fullName.trim() || email.split('@')[0]) || 'You').replace(/^\w/, (c) => c.toUpperCase())
  const mine = children.find((c) => c.auth_user_id === uid)
  if (mine) return { role: 'child', uid, displayName: mine.nickname, email, children: [mine], canWrite }
  // A child's opaque login is a @child.invalid identity. If such a token no longer
  // matches any child row, the profile was deleted out from under it — render the
  // gentle "removed" screen, never mis-classify it as a brand-new empty parent.
  if (email.endsWith('@child.invalid')) return { role: 'child', uid, displayName: '', email, children: [], canWrite, removed: true }
  const asParent = children.filter((c) => c.parent_id === uid)
  if (asParent.length) return { role: 'parent', uid, displayName: label, email, children: asParent, canWrite }
  // a parent who has SET UP a family (homeschool self-serve) but not yet added a
  // child is still a parent — an empty roster, ready to add their first learner.
  if (family) return { role: 'parent', uid, displayName: label, email, children: [], canWrite }
  // tutor ONLY if actually granted (Academy-authorized); never self-declared.
  if (grants.some((g) => g.active)) return { role: 'tutor', uid, displayName: label, email, children, canWrite }
  // A brand-new Google adult with NO children and NO active grant is NOT yet set up:
  // they land in the zero-privilege LOBBY, never auto-promoted to a parent-with-access.
  // Fail-closed default — being "trusted with children" is an explicit later step.
  return { role: 'lobby', uid, displayName: label, email, children: [], canWrite }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let alive = true
    if (!session) { setProfile(null); return }
    setLoading(true)
    loadProfile(session.user.id, session.user.email ?? '', googleFullName(session.user.user_metadata)).then((p) => {
      if (alive) { setProfile(p); setLoading(false) }
    })
    return () => { alive = false }
  }, [session])

  const parentStash = useRef<Session | null>(null)

  const signInAs = useCallback(async (email: string) => {
    if (!ALLOW_DEV_SIGNIN) return 'dev sign-in is disabled in this build'
    const { error } = await supabase.auth.signInWithPassword({ email, password: PW })
    return error ? error.message : null
  }, [])
  const signOut = useCallback(async () => {
    parentStash.current = null
    await supabase.auth.signOut()
    setProfile(null)
  }, [])

  // Step-up re-auth for a destructive action (child deletion). Refreshes the
  // authentication time so the server's fresh-auth gate (amr within 5 min) passes.
  // Real build: a Google re-auth redirect back to the current page. Dev build: a
  // fresh password sign-in (a new amr timestamp) — seamless, no redirect.
  const reauth = useCallback(async () => {
    const email = session?.user.email ?? ''
    if (ALLOW_DEV_SIGNIN && email) {
      const { error } = await supabase.auth.signInWithPassword({ email, password: PW })
      return error ? error.message : null
    }
    // prompt=login forces Google to re-authenticate — a live SSO session must not
    // silently satisfy step-up on a shared family device (real re-proof required).
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href, queryParams: { prompt: 'login' } } })
    return error ? error.message : null // (redirects away on success)
  }, [session])

  const reloadProfile = useCallback(async () => {
    if (!session) return
    setProfile(await loadProfile(session.user.id, session.user.email ?? '', googleFullName(session.user.user_metadata)))
  }, [session])

  // Enter one of the parent's OWN children via the mint; stash the parent session
  // IN MEMORY ONLY (a reload in child mode requires a full parent re-sign-in — the
  // safe failure direction on a shared family device).
  const enterChild = useCallback(async (childId: string) => {
    const res = await startChildSession(childId)
    if ('error' in res) return res.error
    parentStash.current = session
    const { error } = await supabase.auth.setSession({ access_token: res.access_token, refresh_token: res.refresh_token })
    return error ? error.message : null
  }, [session])
  const returnToParent = useCallback(async () => {
    const p = parentStash.current
    parentStash.current = null
    if (p) await supabase.auth.setSession({ access_token: p.access_token, refresh_token: p.refresh_token })
    else { await supabase.auth.signOut(); setProfile(null) } // reloaded → re-auth
  }, [])

  const value = useMemo(() => ({ session, loading, profile, signInAs, signOut, reauth, enterChild, returnToParent, reloadProfile }),
    [session, loading, profile, signInAs, signOut, reauth, enterChild, returnToParent, reloadProfile])
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>
}

export function useSession(): Ctx {
  const ctx = useContext(SessionCtx)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
