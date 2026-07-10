import { useCallback, useState } from 'react'
import { Icon } from '@/components/Icon'
import { deleteChild, loadDeletionReceipt, type DeletionReceipt } from '@/lib/api'
import { useSession } from '@/lib/session'

type Step = 'confirm' | 'deleting' | 'reauth' | 'done' | 'error'

const ERROR_COPY: Record<string, string> = {
  legal_hold: 'These records are under a legal hold and can’t be deleted right now. Please contact support.',
  rate_limited: 'Too many attempts just now — please wait a minute and try again.',
  not_found: 'This child is no longer here.',
  purge_failed: 'Something went wrong and nothing was deleted. Please try again.',
}

// Builds the off-DB receipt anchor: the readable summary + the raw immutable
// receipt, so the parent keeps verifiable proof independent of our database.
function downloadReceipt(nickname: string, r: DeletionReceipt) {
  const payload = {
    kind: 'deletion-receipt',
    generated_at: new Date().toISOString(),
    child_nickname: nickname, // display only — the stored receipt carries opaque ids
    summary: `${nickname}'s account and all learning records were permanently deleted. `
      + `Kept as required proof: ${r.disposition.retained.join(', ')}. `
      + `Re-adding starts from zero. Receipt hash: ${r.receipt_hash}.`,
    receipt: r,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `deletion-receipt-${r.id}.json`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

export function RemoveChildDialog({ childId, nickname, onClose, onDeleted }: {
  childId: string; nickname: string; onClose: () => void; onDeleted: () => void
}) {
  const { reauth } = useSession()
  const [step, setStep] = useState<Step>('confirm')
  const [confirmText, setConfirmText] = useState('')
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null)
  const [errKey, setErrKey] = useState('')

  const doDelete = useCallback(async () => {
    setStep('deleting')
    const res = await deleteChild(childId)
    if ('error' in res) {
      if (res.reauth) { setStep('reauth'); return }
      setErrKey(res.error); setStep('error'); return
    }
    const full = await loadDeletionReceipt(res.receipt_id)
    setReceipt(full)
    onDeleted() // refresh the roster in the background; the child is gone
    setStep('done')
  }, [childId, onDeleted])

  const doReauth = useCallback(async () => {
    setStep('deleting')
    const err = await reauth() // dev: fresh token in-place; real Google: redirects away
    if (err) { setErrKey('purge_failed'); setStep('error'); return }
    await doDelete() // retry with the now-fresh auth_time (dev path)
  }, [reauth, doDelete])

  const del = receipt?.disposition.deleted ?? {}
  const tomb = receipt?.disposition.tombstoned?.authored_messages ?? 0

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={`Remove ${nickname}`}>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-5 shadow-card" data-testid="remove-dialog">

        {step === 'confirm' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--danger, #c0392b)' }}><Icon name="Trash2" size={20} /></span>
              <h2 className="text-lg font-bold text-foreground">Permanently delete {nickname}?</h2>
            </div>
            <p className="text-sm text-muted-foreground">This can’t be undone. Here’s exactly what happens:</p>
            <ul className="flex flex-col gap-2 text-sm">
              <li className="rounded-xl border border-border p-3"><span className="font-semibold text-foreground">Deleted now</span><br /><span className="text-muted-foreground">{nickname}’s profile, progress, practice history, and every learning record.</span></li>
              <li className="rounded-xl border border-border p-3"><span className="font-semibold text-foreground">Kept as required proof</span><br /><span className="text-muted-foreground">A consent record and an access log — no learning data — held for the legal retention period, then deleted.</span></li>
              <li className="rounded-xl border border-border p-3"><span className="font-semibold text-foreground">Re-adding later starts from zero</span><br /><span className="text-muted-foreground">A new consent and a fresh profile. The one-time consent charge isn’t automatically refunded.</span></li>
            </ul>
            <label className="text-sm font-medium text-foreground">Type <span className="font-bold">{nickname}</span> to confirm
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus aria-label="Type the child's nickname to confirm"
                className="mt-1 min-h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-border-strong" />
            </label>
            <div className="flex gap-2">
              <button type="button" data-testid="confirm-delete" disabled={confirmText !== nickname} onClick={doDelete}
                className="min-h-10 flex-1 rounded-full px-4 text-sm font-bold text-white disabled:opacity-50" style={{ background: 'var(--danger, #c0392b)' }}>
                Permanently delete
              </button>
              <button type="button" onClick={onClose} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Cancel</button>
            </div>
          </div>
        )}

        {step === 'deleting' && <p className="py-8 text-center text-sm text-muted-foreground">Deleting {nickname}’s records…</p>}

        {step === 'reauth' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-foreground">Confirm it’s you</h2>
            <p className="text-sm text-muted-foreground">For your child’s safety, deleting an account needs a fresh sign-in.</p>
            <div className="flex gap-2">
              <button type="button" data-testid="reauth" onClick={doReauth} className="min-h-10 flex-1 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">Re-verify &amp; delete</button>
              <button type="button" onClick={onClose} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Cancel</button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-foreground">Couldn’t delete</h2>
            <p className="text-sm text-muted-foreground" data-testid="remove-error">{ERROR_COPY[errKey] ?? 'Something went wrong. Please try again.'}</p>
            <button type="button" onClick={onClose} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Close</button>
          </div>
        )}

        {step === 'done' && receipt && (
          <div className="flex flex-col gap-3" data-testid="deletion-receipt">
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--success)' }}><Icon name="CheckCircle2" size={20} /></span>
              <h2 className="text-lg font-bold text-foreground">{nickname}’s account was deleted</h2>
            </div>
            <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--green-soft)' }}>
              <p className="font-semibold text-foreground">Deleted now</p>
              <p className="text-muted-foreground">{nickname}’s profile and all learning records{tomb > 0 ? `; ${tomb} shared-space message${tomb === 1 ? '' : 's'} redacted (kept for others’ context)` : ''}.</p>
              <p className="mt-2 font-semibold text-foreground">Kept as required proof</p>
              <p className="text-muted-foreground">{receipt.disposition.retained.join(', ')} — no learning data, held for the legal retention period.</p>
              <p className="mt-2 font-semibold text-foreground">Ages out of backups</p>
              <p className="text-muted-foreground">Encrypted backups roll off within the standard backup window.</p>
              {receipt.disposition.entitlement === 'canceled_last_child' && <p className="mt-2 text-muted-foreground">Your subscription was closed (this was your last child).</p>}
            </div>

            <details className="rounded-xl border border-border p-3 text-xs">
              <summary className="cursor-pointer font-semibold text-foreground">Technical proof</summary>
              <dl className="mt-2 flex flex-col gap-1 text-muted-foreground">
                <div><dt className="inline font-medium">Receipt hash: </dt><dd className="inline break-all font-mono">{receipt.receipt_hash}</dd></div>
                <div><dt className="inline font-medium">Chains from: </dt><dd className="inline break-all font-mono">{receipt.prev_receipt_hash ?? '(genesis)'}</dd></div>
                <div><dt className="inline font-medium">Receipt id: </dt><dd className="inline font-mono">{receipt.id}</dd></div>
                <div><dt className="inline font-medium">Revoke record: </dt><dd className="inline font-mono">{receipt.revoke_consent_id ?? '—'}</dd></div>
                <div><dt className="inline font-medium">Status: </dt><dd className="inline">{receipt.status}</dd></div>
                <div><dt className="inline font-medium">Deleted at: </dt><dd className="inline">{receipt.db_purged_at}</dd></div>
                <div className="break-all"><dt className="inline font-medium">Disposition: </dt><dd className="inline font-mono">{JSON.stringify(del)}</dd></div>
              </dl>
            </details>

            <div className="flex gap-2">
              <button type="button" data-testid="download-receipt" onClick={() => downloadReceipt(nickname, receipt)} className="min-h-10 flex-1 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">Download receipt</button>
              <button type="button" onClick={onClose} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
