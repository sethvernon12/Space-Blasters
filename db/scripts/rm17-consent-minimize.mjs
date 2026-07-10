// ============================================================================
// RM-17 consent-minimize (A0) — proves the child's nickname/grade NEVER reach
// Stripe and never land in any surviving evidence row, so the deletion phase's
// AC-1 ("zero child data anywhere") is achievable. Exercises the REAL
// create-consent-checkout (mock Stripe, so no charge) + the REAL signed webhook.
//   1. checkout stashes the nickname in a service-only pending_children row keyed
//      by an OPAQUE token; the returned url carries no nickname.
//   2. pending_children has NO client access (RLS/grants).
//   3. a child identity cannot create a pending checkout (adult-only).
//   4. the signed webhook creates the child from ONLY {parent_uid, token} — no
//      nickname in metadata — and consumes the pending row.
//   5. scrub scan: no surviving evidence row (consent_ledger/audit_log/
//      stripe_events) contains the nickname.
//   6. abandoned checkouts are swept by an AUDITED TTL cleanup.
//   7. refund/dispute webhooks are an explicit no-op (never mutate/delete).
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm17-consent-minimize.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, mintChildSession, adminClient, FAMILY } from './family.mjs'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 8140
const WH = 'whsec_test_rm17_minimize'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
const A = FAMILY.alpha
const NICK = 'MinimizeMe'

console.log('Setup + serve functions (mock Stripe checkout + real signed webhook)…')
const uids = await setupFamily(cfg)
const db = new Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p)
const seth = await signInAs(cfg, A.parent.email)
const brielle = await mintChildSession(cfg, seth.client, A.children.brielle.childId)
const admin = adminClient(cfg)

const envFile = path.join(root, 'supabase', '.env.rm17') // ONLY the WH secret → checkout stays MOCK
fs.writeFileSync(envFile, `STRIPE_WEBHOOK_SECRET=${WH}\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })

const invoke = async (fn, token, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
const postWebhook = async (eventObj) => {
  const payload = JSON.stringify(eventObj); const t = Math.floor(Date.now() / 1000)
  const sig = `t=${t},v1=${createHmac('sha256', WH).update(`${t}.${payload}`).digest('hex')}`
  const r = await fetch(`${cfg.apiUrl}/functions/v1/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': sig, 'Content-Type': 'application/json' }, body: payload })
  return { status: r.status, text: await r.text() }
}
const childCount = async () => (await q(`select count(*)::int n from public.children`)).rows[0].n

// readiness
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke('start-child-session', seth.session.access_token, {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('functions not ready')

try {
  // ---- 1. checkout stashes nickname our side; opaque token → Stripe, never the nickname ----
  console.log('nickname minimization at checkout:')
  const chk = await invoke('create-consent-checkout', seth.session.access_token, { nickname: NICK, gradeBand: '3', returnUrl: `http://127.0.0.1:${PORT}` })
  const pend = (await q(`select token, nickname, grade_band from public.pending_children where parent_id=$1 order by created_at desc limit 1`, [uids.seth])).rows[0]
  const urlHasNick = typeof chk.body?.url === 'string' && chk.body.url.includes(NICK)
  chk.status === 200 && chk.body?.mock === true && pend?.nickname === NICK && pend?.grade_band === '3' && !urlHasNick
    ? ok('checkout → nickname stashed in service-only pending_children (opaque token); returned url carries no nickname')
    : bad(`checkout: ${JSON.stringify({ status: chk.status, mock: chk.body?.mock, pend, urlHasNick })}`)

  // ---- 2. pending_children has NO client access ----
  console.log('pending_children client isolation:')
  const sethRead = await seth.client.from('pending_children').select('token')
  const rows = sethRead.data ?? []
  rows.length === 0 ? ok('pending_children is unreadable by an authenticated parent (service/definer only)') : bad(`parent read pending_children: ${rows.length} rows`)

  // ---- 3. a child identity cannot start a consent checkout (adult-only RPC) ----
  console.log('child cannot create a pending checkout:')
  const childRpc = await brielle.client.rpc('create_pending_child', { p_nickname: 'X', p_grade_band: null })
  childRpc.data?.ok === false && childRpc.data?.error === 'not_authorized'
    ? ok('create_pending_child denies a child actor (not_authorized)') : bad(`child rpc: ${JSON.stringify(childRpc.data)}`)

  // ---- 4. signed webhook creates the child from {parent_uid, token} — NO nickname ----
  console.log('webhook resolves the child from the opaque token (no nickname in metadata):')
  const before = await childCount()
  const evtId = 'evt_rm17_' + uids.seth.slice(0, 8)
  const wh = await postWebhook({ id: evtId, type: 'checkout.session.completed', data: { object: { id: 'cs_' + evtId, payment_intent: 'pi_' + evtId, metadata: { parent_uid: uids.seth, pending_token: pend.token, policy_version: 'v1' } } } })
  const kid = (await q(`select id, nickname, grade_band, consent_id from public.children where parent_id=$1 and nickname=$2`, [uids.seth, NICK])).rows[0]
  const pendGone = (await q(`select count(*)::int n from public.pending_children where token=$1`, [pend.token])).rows[0].n
  wh.status === 200 && kid?.nickname === NICK && kid?.grade_band === '3' && kid?.consent_id && pendGone === 0 && (await childCount()) === before + 1
    ? ok('signed webhook (metadata has NO nickname) created the child with the right nickname; pending row consumed')
    : bad(`webhook: ${JSON.stringify({ wh, kid, pendGone })}`)

  // ---- 5. scrub scan: no surviving EVIDENCE row contains the nickname ----
  console.log('scrub scan of surviving evidence rows:')
  const leaks = (await q(`
    select 'consent_ledger' src from public.consent_ledger where detail::text ilike '%'||$1||'%'
    union all select 'audit_log' from public.audit_log where detail::text ilike '%'||$1||'%'
    union all select 'stripe_events' from public.stripe_events where (event_id||coalesce(kind,'')||coalesce(child_id::text,'')) ilike '%'||$1||'%'`, [NICK])).rows
  const childHasIt = (await q(`select count(*)::int n from public.children where nickname=$1`, [NICK])).rows[0].n
  leaks.length === 0 && childHasIt === 1
    ? ok('the nickname lives ONLY on the (deletable) child row — no consent_ledger/audit_log/stripe_events row carries it')
    : bad(`scrub: leaks=${JSON.stringify(leaks)} childHasIt=${childHasIt}`)

  // ---- 6. abandoned checkouts are swept by an AUDITED TTL cleanup ----
  console.log('TTL cleanup of abandoned checkouts (audited):')
  const expiredTok = (await q(`insert into public.pending_children (parent_id, nickname, expires_at) values ($1,'Abandoned', now() - interval '1 hour') returning token`, [uids.seth])).rows[0].token
  const freshTok = (await q(`insert into public.pending_children (parent_id, nickname) values ($1,'Fresh') returning token`, [uids.seth])).rows[0].token
  const clean = await admin.rpc('cleanup_pending_children')
  const expiredGone = (await q(`select count(*)::int n from public.pending_children where token=$1`, [expiredTok])).rows[0].n
  const freshAlive = (await q(`select count(*)::int n from public.pending_children where token=$1`, [freshTok])).rows[0].n
  const audit = (await q(`select detail->>'deleted' d from public.audit_log where action='consent.pending_cleanup' order by created_at desc limit 1`)).rows[0]
  clean.data?.ok === true && expiredGone === 0 && freshAlive === 1 && Number(audit?.d) >= 1
    ? ok('cleanup swept only the expired row, kept the fresh one, and audited the count (no nickname in the audit)')
    : bad(`cleanup: ${JSON.stringify({ clean: clean.data, expiredGone, freshAlive, audit })}`)

  // ---- 7. refund/dispute webhooks are an explicit no-op ----
  console.log('refund/dispute no-op:')
  const cBefore = await childCount()
  const revBefore = (await q(`select count(*)::int n from public.consent_ledger where action='revoke'`)).rows[0].n
  const refund = await postWebhook({ id: 'evt_rm17_refund', type: 'charge.refunded', data: { object: { id: 'ch_x' } } })
  const dispute = await postWebhook({ id: 'evt_rm17_dispute', type: 'charge.dispute.created', data: { object: { id: 'dp_x' } } })
  const cAfter = await childCount()
  const revAfter = (await q(`select count(*)::int n from public.consent_ledger where action='revoke'`)).rows[0].n
  refund.status === 200 && refund.text === 'ignored_refund_dispute_no_mutation' && dispute.status === 200 && cAfter === cBefore && revAfter === revBefore
    ? ok('charge.refunded / charge.dispute → 200 no-op; no child deleted, no consent revoked')
    : bad(`refund/dispute: ${JSON.stringify({ refund, dispute, cAfter, cBefore, revAfter, revBefore })}`)

  // ---- 8. per-parent anti-accumulation cap on pending rows ----
  console.log('pending-row cap (anti-accumulation):')
  await q(`insert into public.pending_children (parent_id, nickname) select $1, 'Cap'||g from generate_series(1,25) g`, [uids.seth])
  const capped = await seth.client.rpc('create_pending_child', { p_nickname: 'Overflow', p_grade_band: null })
  const overflowRows = (await q(`select count(*)::int n from public.pending_children where parent_id=$1 and nickname='Overflow'`, [uids.seth])).rows[0].n
  capped.data?.ok === false && capped.data?.error === 'too_many_pending' && overflowRows === 0
    ? ok('a parent over the pending cap is rejected (too_many_pending); no overflow row created')
    : bad(`cap: ${JSON.stringify({ capped: capped.data, overflowRows })}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-17 MINIMIZE: ${fails} FAIL ===` : '\n=== RM-17 MINIMIZE: ALL PASS (nickname never reaches Stripe or any evidence row) ===')
process.exit(fails ? 1 : 0)
