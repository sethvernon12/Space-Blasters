import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { GradeReviewCard } from '@/components/GradeReviewCard'
import { listGradeProposals, submitUploadForGrading, type GradeProposal, type Upload } from '@/lib/api'

const OPS: { value: string; sym: string }[] = [
  { value: 'add', sym: '+' }, { value: 'sub', sym: '−' }, { value: 'mul', sym: '×' }, { value: 'div', sym: '÷' },
]

// Phase 5 · 5c. The grading review surface: send one skill-tagged page for grading (MVP: the
// human tags the skill + the problem inline), then work the pending AI proposals through the
// automation-bias-resistant gate (GradeReviewCard). Proposals + their SYSTEM trust signals
// come from list_grade_proposals (server-computed from the trusted problem, never the image).
export function GradeReview({ childId, childName, canWrite, uploads, imageUrls }: {
  childId: string; childName: string; canWrite: boolean; uploads: Upload[]; imageUrls: Record<string, string>
}) {
  const [proposals, setProposals] = useState<GradeProposal[]>([])
  const [uploadId, setUploadId] = useState('')
  const [skill, setSkill] = useState('')
  const [op, setOp] = useState('mul')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => { setProposals(await listGradeProposals(childId)) }, [childId])
  useEffect(() => { void refresh() }, [refresh])
  // liveness: a proposal lands (worker finished) → refresh
  useEffect(() => {
    const ch = supabase.channel(`grade-${childId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grade_proposals', filter: `child_id=eq.${childId}` }, () => { void refresh() })
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [childId, refresh])

  async function onSubmit() {
    if (!uploadId || !skill.trim() || a.trim() === '' || b.trim() === '') { setMsg('Pick a page, tag the skill, and enter the problem.'); return }
    setBusy(true); setMsg(null)
    const r = await submitUploadForGrading(uploadId, skill.trim(), { operator: op, a: Number(a), b: Number(b) }, crypto.randomUUID())
    setBusy(false)
    setMsg(r.ok ? 'Sent for grading — the AI drafts a grade for you to confirm.' : `Could not send: ${r.error}`)
    if (r.ok) { setUploadId(''); setA(''); setB(''); void refresh() }
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
      <span className="text-sm font-semibold text-foreground">Grading</span>

      {canWrite && (
        <div data-testid="grade-submit" className="flex flex-col gap-2 rounded-xl bg-surface-muted p-2">
          <p className="text-xs text-muted-foreground">Send one page for an AI-drafted grade you’ll confirm. Tag the skill and the problem on the page.</p>
          <select value={uploadId} onChange={(e) => setUploadId(e.target.value)} data-testid="grade-upload" aria-label="Page to grade" className="min-h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
            <option value="">Choose a page…</option>
            {uploads.map((u) => <option key={u.id} value={u.id}>{u.note?.trim() || `Page from ${new Date(u.created_at).toLocaleDateString()}`}</option>)}
          </select>
          <div className="flex flex-wrap items-center gap-2">
            <input value={skill} onChange={(e) => setSkill(e.target.value)} data-testid="grade-skill" placeholder="skill (e.g. mult2)" aria-label="Skill tag" className="min-h-9 flex-1 rounded-lg border border-border bg-card px-2 text-sm text-foreground" />
            <input inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} data-testid="grade-a" placeholder="a" aria-label="First number" className="min-h-9 w-14 rounded-lg border border-border bg-card px-2 text-sm text-foreground" />
            <select value={op} onChange={(e) => setOp(e.target.value)} data-testid="grade-op" aria-label="Operator" className="min-h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
              {OPS.map((o) => <option key={o.value} value={o.value}>{o.sym}</option>)}
            </select>
            <input inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} data-testid="grade-b" placeholder="b" aria-label="Second number" className="min-h-9 w-14 rounded-lg border border-border bg-card px-2 text-sm text-foreground" />
            <button type="button" disabled={busy} onClick={onSubmit} data-testid="grade-submit-btn" className="min-h-9 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-60">{busy ? 'Sending…' : 'Send for grading'}</button>
          </div>
          {msg && <p role="status" className="text-xs text-muted-foreground">{msg}</p>}
        </div>
      )}

      {proposals.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="grade-proposals">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Grades to review ({proposals.length})</span>
          {proposals.map((p) => (
            <GradeReviewCard key={p.id} proposal={p} imageUrl={imageUrls[p.upload_id]} canWrite={canWrite} childName={childName} onDone={refresh} />
          ))}
        </div>
      )}
    </div>
  )
}
