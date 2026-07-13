import { useState } from 'react'
import { Icon } from '@/components/Icon'
import { confirmImageGrade, rejectImageGrade, type GradeProposal } from '@/lib/api'

// The automation-bias-resistant human gate for ONE AI grade proposal (Phase 5 · 5c).
// FRICTION is driven by SYSTEM trust signals — solver agreement + detector cleanliness —
// NEVER the model's own confidence. The low-friction single-confirm path is available ONLY
// when the solver AGREES and the image is DETECTOR-CLEAN; anything else escalates to
// mandatory review: correct the read, or explicitly acknowledge you looked, before confirm
// unlocks. The child sees nothing until a human confirms (SAF). All model-authored text is
// rendered as inert text (React escapes) — never dangerouslySetInnerHTML.
export function GradeReviewCard({ proposal, imageUrl, canWrite, childName, onDone }: {
  proposal: GradeProposal; imageUrl?: string; canWrite: boolean; childName: string; onDone: () => void
}) {
  const [corrected, setCorrected] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [override, setOverride] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const lowFriction = proposal.agreement && proposal.detector_clean
  const trimmed = corrected.trim()
  const correctedNum = trimmed === '' ? null : Number(trimmed)
  const correctionValid = trimmed === '' || Number.isInteger(correctedNum)
  // high-risk requires a deliberate act (correct the read OR acknowledge) before confirming;
  // low-risk still requires a click — there is NEVER an automatic / model-confidence approve.
  const canConfirm = canWrite && !busy && correctionValid && (lowFriction || acknowledged || correctedNum !== null)

  async function doConfirm() {
    setBusy(true); setErr(null)
    const r = await confirmImageGrade(proposal.id, { override: override.trim() || null, correctedRead: correctedNum })
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not record the grade.'); return }
    onDone()
  }
  async function doReject() {
    setBusy(true); setErr(null)
    if (!(await rejectImageGrade(proposal.id))) { setErr('Could not reject.'); setBusy(false); return }
    onDone()
  }

  return (
    <div data-testid="grade-review-card" className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3">
      <div className="flex gap-3">
        {imageUrl
          ? <img src={imageUrl} alt={`${childName}'s work, exactly as the grader saw it`} className="h-24 w-24 rounded-lg border border-border object-cover" />
          : <div className="grid h-24 w-24 place-items-center rounded-lg border border-border bg-surface-muted text-muted-foreground"><Icon name="Image" size={20} /></div>}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted-foreground">the sanitized image the grader read</p>
          <p className="mt-1 text-sm text-foreground">Read the answer as <span data-testid="model-read" className="font-bold">{proposal.read_answer ?? '—'}</span></p>
          <div data-testid="trust-signals" className="mt-2 flex flex-wrap gap-1.5">
            <Signal ok={proposal.agreement} label={proposal.agreement ? 'Matches the math' : 'Disagrees with the math'} />
            <Signal ok={proposal.detector_clean} label={proposal.detector_clean ? 'Image verified' : 'Image unverified'} />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Model self-report: {proposal.confidence != null ? `${Math.round(proposal.confidence * 100)}% confident` : '—'} <span className="italic">(shown, not used to decide)</span>
          </p>
        </div>
      </div>

      {proposal.feedback && <p data-testid="ai-feedback" className="rounded-lg bg-surface-muted px-2 py-1 text-sm text-foreground">{proposal.feedback}</p>}

      {canWrite ? (
        <div className="flex flex-col gap-2">
          {!lowFriction && (
            <div data-testid="friction-escalated" className="rounded-lg border p-2 text-xs" style={{ borderColor: 'var(--warning)', background: 'var(--gold-soft)', color: 'var(--warning-text)' }}>
              This one needs your eyes — the read doesn’t clearly match the math{proposal.detector_clean ? '' : ', and the image isn’t verified'}. Correct the read or acknowledge you’ve reviewed it before confirming.
            </div>
          )}
          <label className="text-xs text-muted-foreground">Correct the read (optional)
            <input inputMode="numeric" value={corrected} onChange={(e) => setCorrected(e.target.value)} data-testid="corrected-read" placeholder={proposal.read_answer != null ? String(proposal.read_answer) : ''}
              className="mt-1 min-h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground" aria-label="Correct the read answer" />
          </label>
          {!lowFriction && correctedNum === null && (
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input type="checkbox" checked={acknowledged} data-testid="acknowledge" onChange={(e) => setAcknowledged(e.target.checked)} /> I’ve reviewed {childName}’s work myself
            </label>
          )}
          <textarea value={override} onChange={(e) => setOverride(e.target.value)} rows={2} data-testid="override-feedback"
            placeholder="Add your own note for the child (optional)" className="w-full rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground" aria-label="Your note for the child" />
          {err && <p role="alert" className="text-xs font-medium text-[color:var(--danger)]">{err}</p>}
          <div className="flex gap-2">
            <button type="button" data-testid="confirm-grade" disabled={!canConfirm} onClick={doConfirm}
              className="min-h-9 flex-1 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">
              {lowFriction ? 'Confirm grade' : 'Review & confirm'}
            </button>
            <button type="button" data-testid="reject-grade" disabled={busy} onClick={doReject}
              className="min-h-9 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Reject</button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">A teacher will review and confirm this grade.</p>
      )}
    </div>
  )
}

function Signal({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: ok ? 'var(--green-soft)' : 'var(--surface-muted)', color: ok ? 'var(--success)' : 'var(--muted-foreground)' }}>
      {label}
    </span>
  )
}
