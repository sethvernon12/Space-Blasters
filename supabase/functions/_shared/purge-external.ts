// _shared/purge-external.ts — purge a deleted child's EXTERNAL artifacts: Storage
// objects (homework photos, U4) and AI-provider-held data (Phase 5). The queue row
// (0020) is the durable, retriable record; this does the actual deletion when a
// deletion fires on the DEPARTURE / REQUEST / SCHEDULE path (value-capture §1 / LEG-12
// — never a while-enrolled timer).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { blastRadiusDecision } from './blast-radius.mjs'

export const UPLOADS_BUCKET = 'uploads'

// Delete every Storage object under the deleted child's prefix. CATALOG RECONCILE, not
// backend enumeration: the manifest RPC READS storage.objects (the catalog) to get the
// exact keys + counts; deletion is Storage-API-ONLY (never a SQL delete on
// storage.objects). Legal-hold re-checked (defense-in-depth). Idempotent + forward-
// recovering: it re-lists after deleting and only reports done when the prefix is empty,
// so a partial pass simply retries next time. Records a durable technical annex.
export async function purgeStorage(
  service: SupabaseClient,
  childId: string,
): Promise<{ ok: boolean; detail: string; result?: Record<string, unknown> }> {
  const { data: m, error } = await service.rpc('child_storage_purge_manifest', { p_bucket: UPLOADS_BUCKET, p_child: childId })
  if (error || !m?.ok) return { ok: false, detail: `manifest:${error?.message ?? 'fail'}` }
  if (m.legal_hold) return { ok: false, detail: 'legal_hold', result: { legal_hold: true } } // never purge under a hold

  const objects: string[] = m.objects ?? []
  const childCount: number = m.child_count ?? 0
  const bucketTotal: number = m.bucket_total ?? 0
  if (childCount === 0) return { ok: true, detail: 'empty', result: { objects_purged: 0, child_count: 0 } }

  // prefix-shape guard (defense-in-depth; the RPC already type-guarded p_child)
  if (!/^[0-9a-f-]{36}\/$/i.test(String(m.prefix ?? ''))) return { ok: false, detail: 'bad_prefix' }

  const decision = blastRadiusDecision({ childCount, bucketTotal, listedCount: objects.length })
  if (!decision.proceed) return { ok: false, detail: `breaker:${decision.reason}`, result: { halted: true, page: !!decision.page, child_count: childCount, bucket_total: bucketTotal } }

  // API-ONLY delete (never SQL on storage.objects), batched, idempotent
  let removed = 0
  for (let i = 0; i < objects.length; i += 100) {
    const batch = objects.slice(i, i + 100)
    const { error: rmErr } = await service.storage.from(UPLOADS_BUCKET).remove(batch)
    if (rmErr) return { ok: false, detail: `remove:${rmErr.message}`, result: { objects_purged: removed, child_count: childCount } }
    removed += batch.length
  }

  // forward-recovery verify: the prefix must now be empty, else retry next pass
  const { data: after } = await service.rpc('child_storage_purge_manifest', { p_bucket: UPLOADS_BUCKET, p_child: childId })
  const leftover: number = after?.child_count ?? 0
  if (leftover > 0) return { ok: false, detail: `leftover:${leftover}`, result: { objects_purged: removed, leftover } }

  return { ok: true, detail: 'purged', result: { objects_purged: removed, child_count: childCount, bucket_total: bucketTotal } }
}

// Instruct the AI provider to purge any retained data for the child (belt on top
// of the no-train / zero-data-retention DPA). Mock unless AI_PURGE_URL is set.
export async function purgeAiProvider(childId: string): Promise<{ ok: boolean; detail: string }> {
  const url = Deno.env.get('AI_PURGE_URL') ?? ''
  if (!url) return { ok: true, detail: 'mock' } // ZDR providers retain nothing; this is defense-in-depth
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(Deno.env.get('AI_PURGE_KEY') ? { Authorization: `Bearer ${Deno.env.get('AI_PURGE_KEY')}` } : {}) },
      body: JSON.stringify({ subject_ref: childId }),
    })
    return { ok: res.ok, detail: res.ok ? 'external' : `http_${res.status}` }
  } catch (e) { return { ok: false, detail: `error:${String((e as Error).message).slice(0, 80)}` } }
}
