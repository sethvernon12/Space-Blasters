import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { loadChildrenAndGrants, type ChildRow } from './api'

export type Role = 'parent' | 'child' | 'tutor'

// LOCAL dev "Sign in as…" — real Google OAuth is deferred to DEV promotion.
export const DEV_ACCOUNTS = [
  { label: 'Seth', sub: 'Parent — Brielle & Theo', email: 'seth@local.test', icon: 'Users' },
  { label: 'Brielle', sub: 'Learner', email: 'brielle@local.test', icon: 'Rocket' },
  { label: 'Grandma Rose', sub: 'Tutor for Brielle', email: 'rose@local.test', icon: 'GraduationCap' },
]
const PW = 'localtest123'

export interface Profile { role: Role; uid: string; displayName: string; children: ChildRow[]; canWrite: Record<string, boolean> }

interface Ctx {
  session: Session | null
  loading: boolean
  profile: Profile | null
  signInAs: (email: string) => Promise<string | null>
  signOut: () => Promise<void>
}
const SessionCtx = createContext<Ctx | null>(null)

async function loadProfile(uid: string, email: string): Promise<Profile> {
  const { children, grants } = await loadChildrenAndGrants()
  const canWrite: Record<string, boolean> = {}
  for (const g of grants) if (g.active) canWrite[g.child_id] = g.can_write
  const label = (email.split('@')[0] || 'You').replace(/^\w/, (c) => c.toUpperCase())
  const mine = children.find((c) => c.auth_user_id === uid)
  if (mine) return { role: 'child', uid, displayName: mine.nickname, children: [mine], canWrite }
  const asParent = children.filter((c) => c.parent_id === uid)
  if (asParent.length) return { role: 'parent', uid, displayName: label, children: asParent, canWrite }
  return { role: 'tutor', uid, displayName: label, children, canWrite } // remaining visible = granted
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
    loadProfile(session.user.id, session.user.email ?? '').then((p) => {
      if (alive) { setProfile(p); setLoading(false) }
    })
    return () => { alive = false }
  }, [session])

  const signInAs = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password: PW })
    return error ? error.message : null
  }, [])
  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }, [])

  const value = useMemo(() => ({ session, loading, profile, signInAs, signOut }), [session, loading, profile, signInAs, signOut])
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>
}

export function useSession(): Ctx {
  const ctx = useContext(SessionCtx)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
