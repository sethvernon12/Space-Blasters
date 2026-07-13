import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { GradeReviewCard } from '@/components/GradeReviewCard'
import { createGradeableAssignment, listAssignments, listGradeProposals, submitUploadForGrading, type Assignment, type GradeProposal, type Upload } from '@/lib/api'

const OPS: { value: string; sym: string }[] = [
  { value: 'add', sym: '+' }, { value: 'sub', sym: '−' }, { value: 'mul', sym: '×' }, { value: 'div', sym: '÷' },
]

// Phase 5 · 5c/5e. The grading review surface. A page is graded AGAINST AN ASSIGNMENT — the
// problem comes from the assignment (server-derived, trusted), never typed at submit and never
// the image — then the pending AI proposals are worked through the automation-bias-resistant
// gate (GradeReviewCard). Proposals + their SYSTEM trust signals come from list_grade_proposals.
export function GradeReview({ childId, childName, canWrite, uid, uploads, imageUrls }: {
  childId: string; childName: string; canWrite: boolean; uid: string; uploads: Upload[]; imageUrls: Record<string, string>
}) {
  const [proposals, setProposals] = useState<GradeProposal[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [uploadId, setUploadId] = useState('')
  const [assignmentId, setAssignmentId] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [skill, setSkill] = useState('')
  const [op, setOp] = useState('mul')
  const [a, setA] = useState('')
  const [b, setB] = useState('')

  const refresh = useCallback(async () => {
    setProposals(await listGradeProposals(childId))
    setAssignments((await listAssignments(childId)).filter((x) => x.problem_dna))   // gradeable = has a problem
  }, [childId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const ch = supabase.channel(`grade-${childId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grade_proposals', filter: `child_id=eq.${childId}` }, () => { void refresh() })
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [childId, refresh])

  async function onSubmit() {
    if (!uploadId || !assignmentId) { setMsg('Pick a page and the assignment to grade it against.'); return }
    setBusy(true); setMsg(null)
    const r = await submitUploadForGrading(uploadId, assignmentId, crypto.randomUUID())
    setBusy(false)
    setMsg(r.ok ? 'Sent for grading — the AI drafts a grade for you to confirm.' : `Could not send: ${r.error}`)
    if (r.ok) { setUploadId(''); void refresh() }
  }
  async function onCreateAssignment() {
    if (!title.trim() || !skill.trim() || a.trim() === '' || b.trim() === '') { setMsg('A title, skill, and problem are all needed.'); return }
    setBusy(true); setMsg(null)
    const r = await createGradeableAssignment(childId, uid, skill.trim(), title.trim(), { operator: op, a: Number(a), b: Number(b) })
    setBusy(false)
    if (r.ok) { setMsg('Assignment created — pick it above to grade a page against it.'); setTitle(''); setA(''); setB(''); if (r.id) setAssignmentId(r.id); void refresh() }
    else setMsg(`Could not create: ${r.error}`)
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
      <span className="text-sm font-semibold text-foreground">Grading</span>

      {canWrite && (
        <div data-testid="grade-submit" className="flex flex-col gap-2 rounded-xl bg-surface-muted p-2">
          <p className="text-xs text-muted-foreground">Grade a page against an assignment — the problem comes from the assignment, so the grade is always checked against the real math.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select value={uploadId} onChange={(e) => setUploadId(e.target.value)} data-testid="grade-upload" aria-label="Page to grade" className="min-h-9 flex-1 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
              <option value="">Choose a page…</option>
              {uploads.map((u) => <option key={u.id} value={u.id}>{u.note?.trim() || `Page from ${new Date(u.created_at).toLocaleDateString()}`}</option>)}
            </select>
            <select value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)} data-testid="grade-assignment" aria-label="Assignment" className="min-h-9 flex-1 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
              <option value="">Choose an assignment…</option>
              {assignments.map((x) => <option key={x.id} value={x.id}>{x.title} ({x.problem_dna?.a} {OPS.find((o) => o.value === x.problem_dna?.operator)?.sym ?? '?'} {x.problem_dna?.b})</option>)}
            </select>
            <button type="button" disabled={busy} onClick={onSubmit} data-testid="grade-submit-btn" className="min-h-9 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-60">{busy ? 'Sending…' : 'Send for grading'}</button>
          </div>
          {assignments.length === 0 && <p className="text-xs text-muted-foreground">No gradeable assignments yet — create one below.</p>}
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground" data-testid="new-assignment-toggle">＋ New gradeable assignment</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="asg-title" placeholder="title" aria-label="Assignment title" className="min-h-9 flex-1 rounded-lg border border-border bg-card px-2 text-sm text-foreground" />
              <input value={skill} onChange={(e) => setSkill(e.target.value)} data-testid="asg-skill" placeholder="skill (e.g. mult2)" aria-label="Skill" className="min-h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground" />
              <input inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} data-testid="asg-a" placeholder="a" aria-label="First number" className="min-h-9 w-14 rounded-lg border border-border bg-card px-2 text-sm text-foreground" />
              <select value={op} onChange={(e) => setOp(e.target.value)} data-testid="asg-op" aria-label="Operator" className="min-h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground">{OPS.map((o) => <option key={o.value} value={o.value}>{o.sym}</option>)}</select>
              <input inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} data-testid="asg-b" placeholder="b" aria-label="Second number" className="min-h-9 w-14 rounded-lg border border-border bg-card px-2 text-sm text-foreground" />
              <button type="button" disabled={busy} onClick={onCreateAssignment} data-testid="asg-create" className="min-h-9 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Create</button>
            </div>
          </details>
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
