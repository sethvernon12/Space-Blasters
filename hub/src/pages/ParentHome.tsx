import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { ProgressRing } from '@/components/ProgressRing'
import { MasteryBar } from '@/components/MasteryBar'
import { RemoveChildDialog } from '@/components/RemoveChildDialog'
import { approveAssignment, approveGrade, getChildSummary, getMastery, getPendingAssignments, getPendingGrades, loadChildrenAndGrants, startConsentCheckout, type PendingAssignment, type PendingGrade, type SkillMastery } from '@/lib/api'
import { useSession, type Profile } from '@/lib/session'

const FEATURE_AI = true // flag-gated; routes through the kernel (child-summary + approvals)

// The parent cockpit: one seat over ALL their children — approve, then see
// progress. Every card is a query over the primitives; every button calls an
// existing kernel function.
export default function ParentHome({ profile }: { profile: Profile }) {
  const [byChild, setByChild] = useState<Record<string, SkillMastery[]>>({})
  const [summaries, setSummaries] = useState<Record<string, string | null>>({})
  const [grades, setGrades] = useState<PendingGrade[]>([])
  const [assigns, setAssigns] = useState<PendingAssignment[]>([])
  const [flash, setFlash] = useState<string | null>(null)
  const { enterChild, reloadProfile } = useSession()
  const [addOpen, setAddOpen] = useState(false)
  const [nick, setNick] = useState('')
  const [grade, setGrade] = useState('')
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ id: string; nickname: string } | null>(null)
  const childName = (id: string) => profile.children.find((c) => c.id === id)?.nickname ?? 'your child'

  const [pending, setPending] = useState(false)

  async function addChild(e: FormEvent) {
    e.preventDefault()
    if (!nick.trim()) return
    setBusy(true)
    const res = await startConsentCheckout(nick.trim(), grade.trim() || null)
    if ('error' in res) { setBusy(false); setFlash(`Could not start setup: ${res.error}`); return }
    // stamp the PRE-checkout roster size so the return-poll detects the new child
    // even if the webhook lands before we re-mount (fast payment).
    try { localStorage.setItem('consent_baseline', String(profile.children.length)) } catch { /* private mode */ }
    window.location.assign(res.url) // → Stripe Checkout (or, in mock, straight back to us)
  }
  async function enterHub(id: string) {
    const err = await enterChild(id)
    if (err) setFlash(`Could not enter: ${err}`)
  }

  // On return from Checkout, poll until the webhook-created child appears, then refresh.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('consent') !== 'complete') return
    let cancelled = false
    const stored = (() => { try { return localStorage.getItem('consent_baseline') } catch { return null } })()
    const baseline = stored != null ? Number(stored) : profile.children.length
    try { localStorage.removeItem('consent_baseline') } catch { /* */ }
    ;(async () => {
      setPending(true)
      for (let i = 0; i < 20 && !cancelled; i++) {
        const { children } = await loadChildrenAndGrants() // check FIRST — clears at once if already live
        if (children.length > baseline) { await reloadProfile(); break }
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (!cancelled) { setPending(false); window.history.replaceState({}, '', window.location.pathname) }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async () => {
    const m: Record<string, SkillMastery[]> = {}
    for (const c of profile.children) m[c.id] = await getMastery(c.id)
    setByChild(m)
    if (FEATURE_AI) {
      for (const c of profile.children) { const s = await getChildSummary(c.id); setSummaries((p) => ({ ...p, [c.id]: s?.summary ?? null })) }
      setGrades(await getPendingGrades())
      setAssigns(await getPendingAssignments())
    }
  }, [profile.children])
  useEffect(() => { void load() }, [load])

  async function okGrade(id: string, override?: string) {
    const { error } = await approveGrade(id, override)
    setFlash(error ? `Could not record: ${error.message}` : 'Grade recorded ✓'); void load()
  }
  async function okAssign(id: string) {
    const { error } = await approveAssignment(id)
    setFlash(error ? `Could not deliver: ${error.message}` : 'Assignment delivered ✓'); void load()
  }
  const pendingCount = grades.length + assigns.length

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Your children</h1>
        <p className="text-sm text-muted-foreground">Signed in as {profile.displayName}</p>
      </div>
      {flash && <p className="rounded-xl bg-green-soft px-4 py-2 text-sm font-medium" style={{ color: 'var(--success)' }}>{flash}</p>}
      {pending && <p data-testid="payment-pending" className="rounded-xl px-4 py-2 text-sm font-medium" style={{ background: 'var(--gold-soft)', color: 'var(--warning-text)' }}>Confirming your setup…</p>}

      {/* Cockpit instrument: everything awaiting the parent, across all children */}
      {FEATURE_AI && pendingCount > 0 && (
        <Panel data-testid="parent-approvals" style={{ background: 'var(--gold-soft)' }}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-warning-text"><Icon name="Sparkles" size={16} /></span>
            <span className="text-xs font-bold uppercase tracking-wide text-warning-text">Awaiting your approval</span>
            <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-xs font-bold text-warning-text">{pendingCount}</span>
          </div>
          <ul className="flex flex-col gap-2.5">
            {grades.map((p) => (
              <li key={p.id} className="rounded-xl border border-border bg-card p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-bold text-foreground">{childName(p.child_id)}</span>
                  <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: p.payload.verdict === 'correct' ? 'var(--green-soft)' : 'var(--surface-muted)', color: p.payload.verdict === 'correct' ? 'var(--success)' : 'var(--muted-foreground)' }}>grade · {p.payload.verdict}</span>
                </div>
                <p className="text-sm text-foreground">{p.payload.feedback}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => okGrade(p.id)} className="min-h-9 flex-1 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">Approve</button>
                  <button type="button" onClick={() => okGrade(p.id, 'Let’s review this one together — great effort!')} className="min-h-9 flex-1 rounded-full border border-border text-sm font-semibold text-foreground hover:bg-surface-muted">Override</button>
                </div>
              </li>
            ))}
            {assigns.map((p) => (
              <li key={p.id} className="rounded-xl border border-border bg-card p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-bold text-foreground">{childName(p.child_id)}</span>
                  <span className="text-sm text-muted-foreground">{p.payload.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">assignment · ~{Math.round((p.payload.predicted_p ?? 0) * 100)}%</span>
                </div>
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {(p.payload.items ?? []).map((it, i) => <li key={i} className="rounded-lg bg-surface-muted px-2 py-1 text-xs text-foreground">{it.prompt}</li>)}
                </ul>
                <button type="button" onClick={() => okAssign(p.id)} className="min-h-9 w-full rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">Deliver to student</button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {profile.children.map((c) => {
        const skills = byChild[c.id] ?? []
        const avg = skills.length ? skills.reduce((s, x) => s + x.mastery, 0) / skills.length : 0
        const summary = summaries[c.id]
        return (
          <Panel key={c.id} className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <ProgressRing value={Math.round(avg * 100)} label={`${c.nickname} average mastery`} />
              <div className="flex-1">
                <p className="text-lg font-bold text-foreground">{c.nickname}</p>
                <p className="text-sm text-muted-foreground">
                  {c.grade_band ? `Grade ${c.grade_band}` : 'Learner'} · {skills.length} skill{skills.length === 1 ? '' : 's'} practiced
                </p>
              </div>
            </div>

            {FEATURE_AI && summary && (
              <div className="rounded-2xl border border-border p-4" style={{ background: 'var(--purple-soft)' }} data-testid="ai-summary">
                <div className="mb-1 flex items-center gap-2">
                  <span style={{ color: 'var(--accent-purple)' }}><Icon name="Sparkles" size={16} /></span>
                  <span className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--accent-purple)' }}>Progress summary</span>
                </div>
                <p className="text-sm text-foreground">{summary}</p>
                <p className="mt-2 text-xs text-muted-foreground">Auto-generated from {c.nickname}’s recorded practice · on-device model · nothing invented</p>
              </div>
            )}

            {skills.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {skills.map((s) => (
                  <li key={s.skillKey}>
                    <div className="mb-0.5 flex justify-between text-xs"><span className="font-medium text-foreground">{s.displayName}</span><span className="text-muted-foreground">{Math.round(s.mastery * 100)}% · {s.correct}/{s.attempts}</span></div>
                    <MasteryBar value={s.mastery} />
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No practice recorded yet.</p>}

            {/* child-picker: enter a CONSENTED child's hub via the mint; else awaiting setup (Phase 3.5) */}
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              {c.consent_id
                ? <button type="button" data-testid="enter-child" onClick={() => enterHub(c.id)} className="min-h-9 w-full rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">Practice as {c.nickname}</button>
                : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Awaiting setup — activate to start practice.</span>
                    <button type="button" disabled className="min-h-9 shrink-0 rounded-full border border-border px-4 text-sm font-semibold text-muted-foreground opacity-60">Finish setup</button>
                  </div>
                )}
              {/* deliberate, low-emphasis destructive action: revoke consent -> hard delete */}
              <button type="button" data-testid="remove-child" onClick={() => setRemoveTarget({ id: c.id, nickname: c.nickname })}
                className="flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                <Icon name="Trash2" size={13} /> Remove {c.nickname} &amp; delete all records
              </button>
            </div>
          </Panel>
        )
      })}

      {/* Add a child — a no-email profile under this parent (consent-gated until setup) */}
      <Panel>
        {addOpen ? (
          <form onSubmit={addChild} className="flex flex-col gap-2">
            <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={40} placeholder="Child's nickname" aria-label="Child nickname" autoFocus className="min-h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-border-strong" />
            <input value={grade} onChange={(e) => setGrade(e.target.value)} maxLength={8} placeholder="Grade (optional, e.g. 2)" aria-label="Grade band" className="min-h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-border-strong" />
            <p className="text-xs text-muted-foreground">A nominal, refundable charge verifies you're the parent (COPPA consent) before any of your child's data is collected.</p>
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !nick.trim()} className="min-h-9 flex-1 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-60">{busy ? 'Starting…' : 'Continue to consent'}</button>
              <button type="button" onClick={() => setAddOpen(false)} className="min-h-9 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" data-testid="add-child" onClick={() => setAddOpen(true)} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-full border border-dashed border-border-strong text-sm font-semibold text-muted-foreground hover:bg-surface-muted">
            <Icon name="Plus" size={16} /> Add a child
          </button>
        )}
      </Panel>

      {/* "Delete my account" now lives on the My account page (account menu → My
          account), not in the per-child cockpit. Per-child removal stays here. */}

      {removeTarget && (
        <RemoveChildDialog childId={removeTarget.id} nickname={removeTarget.nickname}
          onClose={() => setRemoveTarget(null)} onDeleted={() => void reloadProfile()} />
      )}
    </div>
  )
}
