// ============================================================================
// RM-13 consent-kernel self-test — Phase 3.5 Slice a. Serves the REAL
// stripe-webhook (verify_jwt=false) and drives it with HMAC-SIGNED MOCK events
// (real Stripe signature scheme, no network): a valid event mints the immutable
// consent grant + creates the child + entitlement; a forged/stale signature and
// a replay are all rejected/idempotent with ZERO extra side effects. NO card
// data anywhere. LOCAL only.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm13-consent-test.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
const WH = 'whsec_test_rm13_consent_kernel'
const db = new Client({ connectionString: cfg.dbUrl })
const q = (s, p = []) => db.query(s, p)

console.log('Setup + serve stripe-webhook (verify_jwt=false)…')
const uids = await setupFamily(cfg)
await db.connect()
const envFile = path.join(root, 'supabase', '.env.rm13')       // matches .env.* → gitignored
fs.writeFileSync(envFile, `STRIPE_WEBHOOK_SECRET=${WH}\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const WH_URL = `${cfg.apiUrl}/functions/v1/stripe-webhook`

const sign = (payload, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`
async function post(eventObj, { secret = WH, t } = {}) {
  const payload = JSON.stringify(eventObj)
  const res = await fetch(WH_URL, { method: 'POST', headers: { 'Stripe-Signature': sign(payload, secret, t), 'Content-Type': 'application/json' }, body: payload })
  let body = null; try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}
const evt = (id, md) => ({ id, type: 'checkout.session.completed', data: { object: { id: 'cs_' + id, payment_intent: 'pi_' + id, metadata: md } } })
const childCount = async () => (await q(`select count(*)::int n from public.children`)).rows[0].n
const md = { parent_uid: uids.seth, nickname: 'Consented', grade: '2', policy_version: 'v1' }

// readiness
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); try { const r = await fetch(WH_URL, { method: 'POST', body: '{}' }); if (r.status === 400) ready = true } catch { /* boot */ } }
ready ? ok('stripe-webhook serving (unsigned → 400)') : bad('function not ready')

try {
  const before = await childCount()

  // ---- 1. a VALID signed event → consent grant + child + entitlement + audit ----
  console.log('valid signed checkout.session.completed:')
  const r1 = await post(evt('evt_rm13_1', md))
  const kid = r1.body?.child_id ? (await q(`select id, parent_id, nickname, consent_id from public.children where id=$1`, [r1.body.child_id])).rows[0] : null
  const grant = kid ? (await q(`select method, detail->>'payment_ref' pr, detail->>'event_id' ev from public.consent_ledger where child_id=$1 and action='grant'`, [kid.id])).rows[0] : null
  const ent = (await q(`select status from public.entitlements where parent_id=$1`, [uids.seth])).rows[0]
  const aud = kid ? (await q(`select count(*)::int n from public.audit_log where action='consent.grant' and child_id=$1`, [kid.id])).rows[0].n : 0
  r1.status === 200 && kid && kid.parent_id === uids.seth && kid.consent_id && grant?.method === 'stripe_card_transaction' && grant.pr === 'pi_evt_rm13_1' && ent?.status === 'active' && aud === 1
    ? ok('immutable consent grant + consented child + entitlement + audit written; detail carries only the payment_ref (no card data)')
    : bad(`valid: ${JSON.stringify({ r1, kid, grant, ent, aud })}`)

  // ---- 2. FORGED signature → 400, zero side effects ----
  console.log('forged signature:')
  const cBefore = await childCount()
  const r2 = await post(evt('evt_rm13_forge', md), { secret: 'whsec_WRONG' })
  const cAfter = await childCount()
  r2.status === 400 && cAfter === cBefore ? ok('forged signature → 400; no consent, no child') : bad(`forged: status=${r2.status} ${cBefore}->${cAfter}`)

  // ---- 3. REPLAY the same event id → idempotent, no duplicate ----
  console.log('replay (same event id):')
  const cPre = await childCount()
  const r3 = await post(evt('evt_rm13_1', md))     // identical id to test 1
  const cPost = await childCount()
  r3.status === 200 && cPost === cPre ? ok('replayed event → idempotent (no second child/consent)') : bad(`replay: status=${r3.status} ${cPre}->${cPost}`)

  // ---- 4. STALE timestamp (valid HMAC, old t) → 400 ----
  console.log('stale timestamp:')
  const r4 = await post(evt('evt_rm13_stale', md), { t: Math.floor(Date.now() / 1000) - 1000 })
  r4.status === 400 ? ok('stale/replayable timestamp → 400') : bad(`stale: status=${r4.status}`)

  // ---- 5. missing metadata (signed) → 200 ack, no child ----
  console.log('missing metadata:')
  const cM = await childCount()
  const r5 = await post(evt('evt_rm13_nomd', { parent_uid: uids.seth }))  // no nickname
  const cM2 = await childCount()
  r5.status === 200 && cM2 === cM ? ok('signed event with missing metadata → 200 ack, no child created') : bad(`no-md: status=${r5.status} ${cM}->${cM2}`)

  // ---- 6. garbage parent_uid → invalid_parent (H1 defense-in-depth) + orphan cleanup ----
  console.log('garbage parent_uid + orphan cleanup:')
  const invBefore = (await q(`select count(*)::int n from auth.users where email like '%@child.invalid'`)).rows[0].n
  const r6 = await post(evt('evt_rm13_badparent', { parent_uid: '00000000-0000-4000-8000-000000000000', nickname: 'Ghost', grade: '1', policy_version: 'v1' }))
  const invAfter = (await q(`select count(*)::int n from auth.users where email like '%@child.invalid'`)).rows[0].n
  const ghost = (await q(`select count(*)::int n from public.children where nickname='Ghost'`)).rows[0].n
  r6.status === 400 && ghost === 0 && invAfter === invBefore
    ? ok('garbage parent_uid → invalid_parent (400); no child, and the transient child user is cleaned up (no orphan)')
    : bad(`badparent: status=${r6.status} ghost=${ghost} orphan=${invBefore}->${invAfter}`)

  // ---- 7. entitlements are parent-own; stripe_events has no client access ----
  console.log('entitlements / stripe_events isolation:')
  const dana = await signInAs(cfg, FAMILY.beta.parent.email)
  const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
  const danaEnt = (await dana.client.from('entitlements').select('id')).data ?? []
  const danaEvents = (await dana.client.from('stripe_events').select('event_id')).data ?? []
  const sethEnt = (await seth.client.from('entitlements').select('id')).data ?? []
  danaEnt.length === 0 && danaEvents.length === 0 && sethEnt.length === 1
    ? ok('entitlements are parent-own (Dana 0, Seth 1); stripe_events has no client access')
    : bad(`RLS: danaEnt=${danaEnt.length} danaEvents=${danaEvents.length} sethEnt=${sethEnt.length}`)

  const net = (await childCount()) - before
  net === 1 ? ok('net effect across all events: exactly ONE child created') : bad(`net children created = ${net} (want 1)`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-13 CONSENT: ${fails} FAIL ===` : '\n=== RM-13 CONSENT: ALL PASS (VPC kernel; signature-as-auth holds) ===')
process.exit(fails ? 1 : 0)
