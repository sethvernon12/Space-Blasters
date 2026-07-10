import { useCallback, useState } from 'react'
import { Icon } from '@/components/Icon'
import { deleteAccount, loadAccountReceipt, type AccountDeletionReceipt } from '@/lib/api'
import { useSession } from '@/lib/session'

type Step = 'confirm' | 'deleting' | 'reauth' | 'done' | 'error'
const CONFIRM_PHRASE = 'delete my account'

const ERROR_COPY: Record<string, string> = {
  legal_hold: 'One of your children’s records is under a legal hold, so the account can’t be deleted right now. Please contact support.',
  rate_limited: 'Too many attempts just now — please wait a minute and try again.',
  purge_failed: 'Something went wrong and nothing was deleted. Please try again.',
}

function downloadReceipt(r: AccountDeletionReceipt) {
  const payload = {
    kind: 'account-deletion-receipt',
    generated_at: new Date().toISOString(),
    summary: `Your account and all ${r.child_count} child profile(s) + learning records were permanently deleted. `
      + `Kept as required proof: ${r.disposition.retained.join(', ')}. Receipt hash: ${r.receipt_hash}.`,
    receipt: r,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `account-deletion-receipt-${r.id}.json`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

export function DeleteAccountDialog({ childCount, onClose, onDone }: { childCount: number; onClose: () => void; onDone: () => void }) {
  const { reauth } = useSession()
  const [step, setStep] = useState<Step>('confirm')
  const [confirmText, setConfirmText] = useState('')
  const [receipt, setReceipt] = useState<AccountDeletionReceipt | null>(null)
  const [errKey, setErrKey] = useState('')

  const doDelete = useCallback(async () => {
    setStep('deleting')
    const res = await deleteAccount()
    if ('error' in res) {
      if (res.reauth) { setStep('reauth'); return }
      setErrKey(res.error); setStep('error'); return
    }
    setReceipt(await loadAccountReceipt(res.account_receipt_id)) // still readable on the just-invalidated token
    setStep('done')
  }, [])

  const doReauth = useCallback(async () => {
    setStep('deleting')
    const err = await reauth()
    if (err) { setErrKey('purge_failed'); setStep('error'); return }
    await doDelete()
  }, [reauth, doDelete])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Delete my account">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-5 shadow-card" data-testid="delete-account-dialog">

        {step === 'confirm' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--danger, #c0392b)' }}><Icon name="Trash2" size={20} /></span>
              <h2 className="text-lg font-bold text-foreground">Delete your entire account?</h2>
            </div>
            <p className="text-sm text-muted-foreground">This can’t be undone. Here’s exactly what happens:</p>
            <ul className="flex flex-col gap-2 text-sm">
              <li className="rounded-xl border border-border p-3"><span className="font-semibold text-foreground">Deleted now</span><br /><span className="text-muted-foreground">Your sign-in and <span className="font-semibold">all {childCount} child profile{childCount === 1 ? '' : 's'}</span> — every profile, progress, practice history, and learning record.</span></li>
              <li className="rounded-xl border border-border p-3"><span className="font-semibold text-foreground">Kept as required proof</span><br /><span className="text-muted-foreground">A consent record and an access log — no learning data — held for the legal retention period, then deleted.</span></li>
              <li className="rounded-xl border border-border p-3"><span className="font-semibold text-foreground">Signing up again starts from zero</span><br /><span className="text-muted-foreground">A brand-new account and fresh consent. The one-time consent charge(s) aren’t automatically refunded.</span></li>
            </ul>
            <label className="text-sm font-medium text-foreground">Type <span className="font-bold">{CONFIRM_PHRASE}</span> to confirm
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus aria-label="Type the confirmation phrase"
                className="mt-1 min-h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-border-strong" />
            </label>
            <div className="flex gap-2">
              <button type="button" data-testid="confirm-delete-account" disabled={confirmText.trim().toLowerCase() !== CONFIRM_PHRASE} onClick={doDelete}
                className="min-h-10 flex-1 rounded-full px-4 text-sm font-bold text-white disabled:opacity-50" style={{ background: 'var(--danger, #c0392b)' }}>
                Permanently delete my account
              </button>
              <button type="button" onClick={onClose} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Cancel</button>
            </div>
          </div>
        )}

        {step === 'deleting' && <p className="py-8 text-center text-sm text-muted-foreground">Deleting your account…</p>}

        {step === 'reauth' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-foreground">Confirm it’s you</h2>
            <p className="text-sm text-muted-foreground">For your family’s safety, deleting your account needs a fresh sign-in.</p>
            <div className="flex gap-2">
              <button type="button" data-testid="reauth-account" onClick={doReauth} className="min-h-10 flex-1 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">Re-verify &amp; delete</button>
              <button type="button" onClick={onClose} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Cancel</button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-foreground">Couldn’t delete</h2>
            <p className="text-sm text-muted-foreground" data-testid="delete-account-error">{ERROR_COPY[errKey] ?? 'Something went wrong. Please try again.'}</p>
            <button type="button" onClick={onClose} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Close</button>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col gap-3" data-testid="account-deletion-receipt">
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--success)' }}><Icon name="CheckCircle2" size={20} /></span>
              <h2 className="text-lg font-bold text-foreground">Your account was deleted</h2>
            </div>
            {receipt ? (
              <>
                <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--green-soft)' }}>
                  <p className="font-semibold text-foreground">Deleted now</p>
                  <p className="text-muted-foreground">Your sign-in and all {receipt.child_count} child profile{receipt.child_count === 1 ? '' : 's'} and their learning records{receipt.disposition.parent_messages_tombstoned > 0 ? `; ${receipt.disposition.parent_messages_tombstoned} of your shared-space message${receipt.disposition.parent_messages_tombstoned === 1 ? '' : 's'} redacted` : ''}.</p>
                  <p className="mt-2 font-semibold text-foreground">Kept as required proof</p>
                  <p className="text-muted-foreground">{receipt.disposition.retained.join(', ')} — no learning data, held for the legal retention period.</p>
                  <p className="mt-2 font-semibold text-foreground">Ages out of backups</p>
                  <p className="text-muted-foreground">Encrypted backups roll off within the standard backup window.</p>
                </div>
                <details className="rounded-xl border border-border p-3 text-xs">
                  <summary className="cursor-pointer font-semibold text-foreground">Technical proof</summary>
                  <dl className="mt-2 flex flex-col gap-1 text-muted-foreground">
                    <div><dt className="inline font-medium">Receipt hash: </dt><dd className="inline break-all font-mono">{receipt.receipt_hash}</dd></div>
                    <div><dt className="inline font-medium">Chains from: </dt><dd className="inline break-all font-mono">{receipt.prev_receipt_hash ?? '(genesis)'}</dd></div>
                    <div><dt className="inline font-medium">Receipt id: </dt><dd className="inline font-mono">{receipt.id}</dd></div>
                    <div><dt className="inline font-medium">Children deleted: </dt><dd className="inline">{receipt.child_count}</dd></div>
                    <div><dt className="inline font-medium">Status: </dt><dd className="inline">{receipt.status}</dd></div>
                    <div><dt className="inline font-medium">Deleted at: </dt><dd className="inline">{receipt.db_purged_at}</dd></div>
                  </dl>
                </details>
              </>
            ) : <p className="text-sm text-muted-foreground">Your receipt is being finalized — you’ll find it in your records.</p>}
            <div className="flex gap-2">
              {receipt && <button type="button" data-testid="download-account-receipt" onClick={() => downloadReceipt(receipt)} className="min-h-10 flex-1 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">Download receipt</button>}
              <button type="button" data-testid="account-done" onClick={onDone} className="min-h-10 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface-muted">Sign out</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
