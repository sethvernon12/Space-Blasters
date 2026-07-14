// ============================================================================
// RM-42 real export/purge sinks (Phase 5 · Slice 1). Proves the deletion covenant's
// "a receipt is shreddable only after its off-DB export is CONFIRMED" is literally true,
// against the REAL DEV receipt-sink Edge fn + private anchor bucket (and the AI-purge
// stub for the real fetch/retry path). Substitutes ONLY the endpoint, never the logic.
//
//   L1  receipt-sink: write, read-back, bad-secret 401, extra-field 400 (opaqueness),
//       immutable (replay idempotent / different-hash 409), unknown 404.
//   L4  SQL gate: mark_receipt_exported REJECTS mock/unknown/null (D2 allowlist);
//       an un-anchored receipt is listed as awaiting AND is NOT shreddable (fail-safe).
//   L3  CASE 1 (confirmed export, request path): delete-child → a CONFIRMED 'anchored'
//       row + the anchor object is retrievable.
//   L5  CASE 4 (re-export drain, D1): an aged un-anchored receipt (a failed request-path
//       export) → the worker's re-export drain confirms it → 'anchored' appears.
//       CASE 2 (shred only behind confirmed): now it shreds; an un-anchored control does not.
//   L6  AI-purge: stub is opaque-uuid ONLY; the worker uses the REAL fetch (success →
//       done; the fail-ref → a real failure the queue parks/retries).
//   L7  two-family anchor ISOLATION: neither family (nor anon) can read the anchor store.
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm42-receipt-anchor-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

const ANCHOR_SECRET = 'anchor_secret_rm42'
const AISTUB_SECRET = 'aistub_secret_rm42'
const MAINT_SECRET = 'maint_secret_rm42'
// The TEST host reaches functions via the published gateway port (127.0.0.1:54321). But a
// served function reaching ANOTHER served function must use the gateway's INTERNAL docker
// hostname (kong:8000) — host loopback is unreachable from inside the edge-runtime
// container. So the request-path/worker sink URLs (in the env file) use the internal base;
// the host-driven L1/L6a calls (callSink/callStub) use the published port.
const SINK_URL = `${cfg.apiUrl}/functions/v1/receipt-sink`       // host → gateway (L1)
const AISTUB_URL = `${cfg.apiUrl}/functions/v1/ai-purge-stub`    // host → gateway (L6a)
const INTERNAL_BASE = 'http://kong:8000'                         // function → gateway (L3/L5/L6b)
const SINK_URL_INTERNAL = `${INTERNAL_BASE}/functions/v1/receipt-sink`
const AISTUB_URL_INTERNAL = `${INTERNAL_BASE}/functions/v1/ai-purge-stub`

console.log('Setup + serve receipt-sink / ai-purge-stub / maintenance-worker / delete-child…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)

const envFile = path.join(root, 'supabase', '.env.rm42')
fs.writeFileSync(envFile, [
  `MAINTENANCE_SECRET=${MAINT_SECRET}`,
  `RECEIPT_EXPORT_SINK=${SINK_URL_INTERNAL}`,
  `RECEIPT_EXPORT_KEY=${ANCHOR_SECRET}`,
  `RECEIPT_SINK_SECRET=${ANCHOR_SECRET}`,
  `AI_PURGE_URL=${AISTUB_URL_INTERNAL}`,
  `AI_PURGE_KEY=${AISTUB_SECRET}`,
  `AI_PURGE_STUB_SECRET=${AISTUB_SECRET}`,
  `AI_PURGE_STUB_DEV=1`, // structural DEV-only gate — the stub is inert (404) without this flag
  `AI_PURGE_STUB_FAIL_REF=${CID.Theo}`, // Theo's opaque id always 500s at the stub (real-failure proof)
  '',
].join('\n'))
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })

const runWorker = async (body = {}, secret = MAINT_SECRET) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/maintenance-worker`, { method: 'POST', headers: { 'X-Maintenance-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
const callSink = async (method, { receipt_id, body, secret = ANCHOR_SECRET } = {}) => {
  const url = method === 'GET' ? `${SINK_URL}?receipt_id=${encodeURIComponent(receipt_id)}` : SINK_URL
  const r = await fetch(url, { method, headers: { 'X-Receipt-Sink-Secret': secret, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
const callStub = async (body, secret = AISTUB_SECRET) => {
  const r = await fetch(AISTUB_URL, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
const invoke = async (token, fn, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}

let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await runWorker({}, 'wrong').catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('functions not ready')

// helper: does an anchor object exist for a receipt (admin/service can read; clients can't)?
const anchorExists = async (rid) => !(await admin.storage.from('receipt-anchor').download(`receipts/${rid}.json`)).error
const seedReceipt = async (cid, ageInterval) =>
  (await q(`insert into public.deletion_receipts (child_id, parent_id, deleting_actor, disposition, receipt_hash, status, created_at, db_purged_at)
    values ($1,$2,$3,'{}'::jsonb, $4, 'completed', now()-$5::interval, now()-$5::interval) returning id`,
    [cid, uids.seth, uids.seth, 'sha256:' + cid.slice(0, 12), ageInterval]))[0].id

try {
  // ===== L1: receipt-sink direct (host → gateway) =====
  console.log('receipt-sink: write / read-back / opaqueness / immutability:')
  const rid1 = uuid(), hash1 = 'sha256:' + rid1.replace(/-/g, '')
  const wBad = await callSink('POST', { body: { receipt_id: rid1, receipt_hash: hash1, kind: 'child', status: 'completed' }, secret: 'wrong' })
  wBad.status === 401 ? ok('receipt-sink: bad secret → 401 (fail-closed)') : bad(`sink bad-secret: ${wBad.status}`)
  const wExtra = await callSink('POST', { body: { receipt_id: rid1, receipt_hash: hash1, kind: 'child', status: 'completed', nickname: 'Brielle' } })
  wExtra.status === 400 ? ok('receipt-sink: an extra field (nickname) is REJECTED — payload opaqueness') : bad(`sink extra-field: ${wExtra.status}`)
  const wOk = await callSink('POST', { body: { receipt_id: rid1, receipt_hash: hash1, kind: 'child', status: 'completed' } })
  wOk.status === 200 && wOk.body?.stored === 'written' ? ok('receipt-sink: writes the opaque anchor') : bad(`sink write: ${JSON.stringify(wOk)}`)
  const g1 = await callSink('GET', { receipt_id: rid1 })
  const anchorKeys = g1.body ? Object.keys(g1.body).sort().join(',') : ''
  g1.status === 200 && g1.body?.receipt_hash === hash1 && anchorKeys === 'kind,receipt_hash,receipt_id,status'
    ? ok('receipt-sink: read-back matches AND stored keys are EXACTLY the 4 opaque fields (no PII / disposition / hash-chain)')
    : bad(`sink read-back: status=${g1.status} keys=${anchorKeys}`)
  const wReplay = await callSink('POST', { body: { receipt_id: rid1, receipt_hash: hash1, kind: 'child', status: 'completed' } })
  const wTamper = await callSink('POST', { body: { receipt_id: rid1, receipt_hash: 'sha256:TAMPER', kind: 'child', status: 'completed' } })
  wReplay.body?.stored === 'idempotent' && wTamper.status === 409
    ? ok('receipt-sink: immutable — same-hash replay idempotent, a different hash for the same id → 409 conflict')
    : bad(`sink immutability: replay=${JSON.stringify(wReplay.body)} tamper=${wTamper.status}`)
  const gMiss = await callSink('GET', { receipt_id: uuid() })
  gMiss.status === 404 ? ok('receipt-sink: unknown receipt → 404') : bad(`sink miss: ${gMiss.status}`)

  // ===== L6a: ai-purge-stub direct (opaque-uuid ONLY) =====
  console.log('ai-purge-stub: opaque-uuid-only guard:')
  const sBad = await callStub({ subject_ref: CID.Wren }, 'wrong')
  const sExtra = await callStub({ subject_ref: CID.Wren, name: 'Wren' })
  const sNon = await callStub({ subject_ref: 'not-a-uuid' })
  const sOk = await callStub({ subject_ref: CID.Wren })
  const sFail = await callStub({ subject_ref: CID.Theo }) // FAIL_REF
  sBad.status === 401 && sExtra.status === 400 && sNon.status === 400 && sOk.status === 200 && sFail.status === 500
    ? ok('ai-purge-stub: bad-auth 401, extra-field 400, non-uuid 400, opaque uuid 200, fail-ref 500')
    : bad(`stub: bad=${sBad.status} extra=${sExtra.status} non=${sNon.status} ok=${sOk.status} fail=${sFail.status}`)

  // ===== L4: SQL gate — mark allowlist + fail-safe + awaiting listing =====
  console.log('shred gate: allowlist + fail-safe:')
  const mMock = (await q(`select public.mark_receipt_exported($1,'mock') r`, [uuid()]))[0].r
  const mUnknown = (await q(`select public.mark_receipt_exported($1,'unknown') r`, [uuid()]))[0].r
  const mNull = (await q(`select public.mark_receipt_exported($1,null) r`, [uuid()]))[0].r
  const mAnchored = (await q(`select public.mark_receipt_exported($1,'anchored') r`, [uuid()]))[0].r
  !mMock.ok && !mUnknown.ok && !mNull.ok && mAnchored.ok
    ? ok('mark_receipt_exported: REJECTS mock/unknown/null, accepts only a CONFIRMED anchor (D2 allowlist)')
    : bad(`mark: mock=${JSON.stringify(mMock)} unknown=${JSON.stringify(mUnknown)} null=${JSON.stringify(mNull)} anchored=${JSON.stringify(mAnchored)}`)

  // an aged (9yr) un-anchored receipt: listed as AWAITING + NOT shreddable (CASE 3 fail-safe)
  const rAwait = await seedReceipt(uuid(), '9 years')
  const awaiting = await q(`select receipt_id from public.list_receipts_awaiting_export(200, interval '5 minutes')`)
  const listedBefore = awaiting.some((r) => r.receipt_id === rAwait)
  const shred1 = (await q(`select public.expire_retained_evidence(now()) r`))[0].r.shredded
  const awaitKeptBefore = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [rAwait]))[0].n === 1
  listedBefore && awaitKeptBefore
    ? ok(`CASE 3 (fail-safe): an un-anchored receipt is listed awaiting-export AND is NOT shredded even at 9yr (${JSON.stringify(shred1)})`)
    : bad(`awaiting/fail-safe: listed=${listedBefore} keptAfterShred=${awaitKeptBefore}`)

  // ===== L3: CASE 1 — delete-child confirms the anchor on the request path =====
  console.log('CASE 1 (confirmed export, request path): delete-child → anchored + retrievable:')
  const sethFresh = await signInAs(cfg, A.parent.email) // fresh token so step-up passes
  const dc = await invoke(sethFresh.session.access_token, 'delete-child', { childId: CID.Brielle })
  const brielleRid = dc.body?.receipt_id
  const brielleMarked = brielleRid && (await q(`select sink from public.receipt_exports where receipt_id=$1`, [brielleRid]))[0]?.sink === 'anchored'
  const brielleObject = brielleRid && await anchorExists(brielleRid)
  dc.status === 200 && brielleMarked && brielleObject
    ? ok('CASE 1: delete-child wrote a CONFIRMED "anchored" export row AND the off-DB anchor object is retrievable')
    : bad(`case1: status=${dc.status} rid=${brielleRid} marked=${brielleMarked} object=${brielleObject}`)

  // enqueue Theo's external purge (Theo is the AI fail-ref) to exercise a REAL AI failure
  await q(`select public.purge_child($1,$2,$3)`, [CID.Theo, uids.seth, uids.seth])

  // ===== L5: CASE 4 (re-export drain) + CASE 2 (shred only behind confirmed) + L6b (AI worker) =====
  console.log('CASE 4 (re-export drain) + CASE 2 (shred) + AI real-fetch:')
  const w1 = await runWorker({})
  const awaitAnchoredNow = (await q(`select sink from public.receipt_exports where receipt_id=$1`, [rAwait]))[0]?.sink === 'anchored'
  const awaitObjectNow = await anchorExists(rAwait)
  awaitAnchoredNow && awaitObjectNow && (w1.body?.export_drain?.exported >= 1)
    ? ok(`CASE 4 (D1 drain): the aged un-anchored receipt was re-exported by the worker (export_drain=${JSON.stringify(w1.body?.export_drain)}) — anchor now confirmed`)
    : bad(`case4: anchored=${awaitAnchoredNow} object=${awaitObjectNow} drain=${JSON.stringify(w1.body?.export_drain)}`)

  // a control seeded AFTER the drain, so it stays genuinely un-anchored (the drain never saw it):
  // even at 9yr it must NOT shred, while the now-anchored rAwait does — same expire call.
  const rKept = await seedReceipt(uuid(), '9 years')
  const shred2 = (await q(`select public.expire_retained_evidence(now()) r`))[0].r.shredded
  const awaitShreddedNow = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [rAwait]))[0].n === 0
  const controlStillKept = (await q(`select count(*)::int n from public.deletion_receipts where id=$1`, [rKept]))[0].n === 1
  awaitShreddedNow && controlStillKept
    ? ok(`CASE 2: once CONFIRMED-anchored the receipt shreds; a still-un-anchored control is retained in the SAME expire call (${JSON.stringify(shred2)})`)
    : bad(`case2: shredded=${awaitShreddedNow} controlKept=${controlStillKept}`)

  // AI real-fetch: Brielle (non-fail-ref) drained to 'done'; Theo (fail-ref) got a REAL 500 → parked pending
  const brielleAi = (await q(`select status from public.external_purge_queue where child_id=$1 and kind='ai'`, [CID.Brielle]))[0]?.status
  const theoAi = (await q(`select status, last_error from public.external_purge_queue where child_id=$1 and kind='ai'`, [CID.Theo]))[0]
  brielleAi === 'done' && theoAi?.status === 'pending' && /transient|http_500/i.test(theoAi?.last_error ?? '')
    ? ok(`AI real-fetch path: Brielle 'ai' → done (200); Theo 'ai' → a REAL failure parked pending (last_error=${theoAi?.last_error}) — not the mock branch`)
    : bad(`ai: brielle=${brielleAi} theo=${JSON.stringify(theoAi)}`)

  // ===== L7: two-family anchor ISOLATION — no family (nor anon) can read the anchor store =====
  console.log('anchor isolation: the off-DB anchor store is service-only:')
  const parentAClient = (await signInAs(cfg, A.parent.email)).client
  const parentBClient = (await signInAs(cfg, B.parent.email)).client
  const anonClient = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false } })
  const cannotRead = async (client) => {
    const d = await client.storage.from('receipt-anchor').download(`receipts/${brielleRid}.json`)
    const l = await client.storage.from('receipt-anchor').list('receipts')
    return !!d.error && (!!l.error || (l.data ?? []).length === 0)
  }
  const aDenied = await cannotRead(parentAClient)   // even the OWNING family cannot read the anchor store
  const bDenied = await cannotRead(parentBClient)   // cross-family: the other family cannot either
  const anonDenied = await cannotRead(anonClient)
  const adminCanRead = await anchorExists(brielleRid) // service role (the only reader) still can
  aDenied && bDenied && anonDenied && adminCanRead
    ? ok('anchor isolation: neither the owning family, the other family, nor anon can read/list the anchor bucket; only the service role can')
    : bad(`isolation: aDenied=${aDenied} bDenied=${bDenied} anonDenied=${anonDenied} adminCanRead=${adminCanRead}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-42 RECEIPT ANCHOR: ${fails} FAIL ===` : '\n=== RM-42 RECEIPT ANCHOR: ALL PASS (real sink; confirmed-before-shred; allowlist gate; re-export drain; AI real-fetch; anchor isolation; opaqueness) ===')
process.exit(fails ? 1 : 0)
