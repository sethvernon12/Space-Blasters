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

// Export the receipt to a durable off-DB store — the PITR replay anchor. Returns
// ok:true with sink:'anchored' ONLY when the anchor is CONFIRMED durable: written AND
// read back with a matching hash. A bare HTTP 2xx is a CLAIM, not a confirmation — the
// covenant lets a receipt become shreddable only behind a confirmed anchor, so we mirror
// the storage sink's discipline (write, then re-read the authoritative store). Any
// failure — no sink configured, write/read error, or a hash mismatch — returns ok:false
// (never a confirmed label), so mark_receipt_exported is not called and retention keeps
// the receipt. A transient failure is retried automatically by the maintenance-worker's
// re-export drain (list_receipts_awaiting_export). Only opaque ids + hash ever leave.
export async function exportReceipt(r: ReceiptAnchor): Promise<{ ok: boolean; sink: string }> {
  const sink = Deno.env.get('RECEIPT_EXPORT_SINK') ?? ''
  if (!sink) return { ok: false, sink: 'mock' } // no sink ⇒ no confirmed anchor (fail-safe: not shreddable)
  const key = Deno.env.get('RECEIPT_EXPORT_KEY') ?? ''
  const authH: Record<string, string> = key ? { 'X-Receipt-Sink-Secret': key } : {}
  try {
    // 1) WRITE — opaque ids + hash only
    const w = await fetch(sink, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authH },
      body: JSON.stringify({ receipt_id: r.receipt_id, receipt_hash: r.receipt_hash, kind: r.kind, status: r.status }),
    })
    if (!w.ok) return { ok: false, sink: 'mock' }
    // 2) READ-AFTER-WRITE CONFIRM — independently re-read the anchor and match the hash.
    // Build the URL structurally (not by string concat) so an existing query string / path
    // on RECEIPT_EXPORT_SINK can never break the confirm and silently strand the receipt.
    const gUrl = new URL(sink); gUrl.searchParams.set('receipt_id', r.receipt_id)
    const g = await fetch(gUrl, { headers: authH })
    if (!g.ok) return { ok: false, sink: 'mock' }
    const back = await g.json().catch(() => null)
    if (!back || back.receipt_id !== r.receipt_id || back.receipt_hash !== r.receipt_hash) return { ok: false, sink: 'mock' }
    return { ok: true, sink: 'anchored' } // CONFIRMED durable off-DB anchor
  } catch { return { ok: false, sink: 'mock' } } // fail-closed → the re-export drain retries
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
