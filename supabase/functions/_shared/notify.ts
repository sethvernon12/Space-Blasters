// _shared/notify.ts — post-deletion OFF-DB anchor + parent email. Same FAIL-CLOSED
// mock doctrine as the AI gateway + Stripe: with no external sink/provider
// configured, both return a deterministic MOCK result and NEVER touch an external
// service — so LOCAL/staging is self-contained and a real sink is used ONLY when
// explicitly keyed at the gate. A deletion receipt carries opaque ids only (the
// nickname lives on the deleted row, never here), so nothing sensitive is emitted.

export interface ReceiptAnchor {
  receipt_id: string
  receipt_hash: string
  kind: 'child' | 'account'
  status: string
}

// Export the receipt to a durable off-DB store — the PITR replay anchor. Mock
// (no RECEIPT_EXPORT_SINK) records intent only; a real object-store PUT otherwise.
export async function exportReceipt(r: ReceiptAnchor): Promise<{ ok: boolean; sink: string }> {
  const sink = Deno.env.get('RECEIPT_EXPORT_SINK') ?? ''
  if (!sink) return { ok: true, sink: 'mock' } // deterministic, no external write
  try {
    const res = await fetch(sink, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // opaque ids + hash only — the durable anchor for post-restore replay
      body: JSON.stringify({ receipt_id: r.receipt_id, receipt_hash: r.receipt_hash, kind: r.kind, status: r.status }),
    })
    return { ok: res.ok, sink: res.ok ? 'external' : 'mock' }
  } catch { return { ok: false, sink: 'mock' } } // fail-closed → the reconcile drain retries
}

// Email the parent a deletion confirmation (the receipt hash as an external anchor).
// Mock (no EMAIL_PROVIDER_URL) records intent only; a real provider POST otherwise.
// Only the receipt hash + kind are sent — never a child's name or learning data.
export async function emailReceipt(parentUid: string, r: ReceiptAnchor): Promise<{ sent: boolean; provider: string }> {
  const url = Deno.env.get('EMAIL_PROVIDER_URL') ?? ''
  if (!url) return { sent: true, provider: 'mock' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(Deno.env.get('EMAIL_PROVIDER_KEY') ? { Authorization: `Bearer ${Deno.env.get('EMAIL_PROVIDER_KEY')}` } : {}) },
      body: JSON.stringify({ parent_uid: parentUid, subject: 'Your deletion is complete', receipt_hash: r.receipt_hash, kind: r.kind }),
    })
    return { sent: res.ok, provider: res.ok ? 'external' : 'mock' }
  } catch { return { sent: false, provider: 'mock' } }
}
