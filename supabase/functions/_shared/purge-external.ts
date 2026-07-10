// _shared/purge-external.ts — purge a deleted child's EXTERNAL artifacts: Storage/
// CDN objects (homework photos) and AI-provider-held data. Same FAIL-CLOSED mock
// doctrine as the AI gateway / Stripe / notify: with nothing configured it returns
// a deterministic MOCK success (there is nothing to purge yet — uploads/AI grading
// are Phase 4/5), and hits a real endpoint ONLY when explicitly keyed at the gate.
// The queue row (0020) is the durable, retriable record either way.

// Delete every Storage object under the child's prefix + issue a CDN purge.
// Real: needs STORAGE_PURGE_URL (an operator endpoint / signed worker) — never a
// client-supplied value. Mock otherwise.
export async function purgeStorage(childId: string): Promise<{ ok: boolean; detail: string }> {
  const url = Deno.env.get('STORAGE_PURGE_URL') ?? ''
  if (!url) return { ok: true, detail: 'mock' } // nothing to purge yet (no uploads feature)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(Deno.env.get('STORAGE_PURGE_KEY') ? { Authorization: `Bearer ${Deno.env.get('STORAGE_PURGE_KEY')}` } : {}) },
      body: JSON.stringify({ child_id: childId, prefix: `child/${childId}/` }),
    })
    return { ok: res.ok, detail: res.ok ? 'external' : `http_${res.status}` }
  } catch (e) { return { ok: false, detail: `error:${String((e as Error).message).slice(0, 80)}` } }
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
