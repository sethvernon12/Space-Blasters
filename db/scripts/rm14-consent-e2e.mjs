// ============================================================================
// RM-14 consent e2e — Phase 3.5b. The full VPC flow, LOCAL, mock-Stripe checkout
// + a REAL signed webhook: (1) SEC-REV-21 — create-consent-checkout stamps
// parent_uid server-side (a forged body value is ignored) and a child can't start
// a checkout; (2) UI — add-a-child → checkout(mock) → payment-pending → signed
// webhook creates the consented child → it activates → enter via the mint → return.
// Prereq: hub built with VITE_ALLOW_DEV_SIGNIN=true.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm14-consent-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const PORT = 8130
const WH = 'whsec_test_rm14'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
const A = FAMILY.alpha
const CID = { Brielle: A.children.brielle.childId }
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built'); process.exit(1) }

console.log('Setup + serve functions (mock Stripe, WH secret) + dist…')
const uids = await setupFamily(cfg)
const seth = await signInAs(cfg, A.parent.email)
const brielle = await mintChildSession(cfg, seth.client, CID.Brielle)
const envFile = path.join(root, 'supabase', '.env.rm14') // only the WH secret → create-consent-checkout stays MOCK
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
  return r.status
}
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke('start-child-session', seth.session.access_token, {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('functions not ready')
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch({ args: ['--disable-web-security'] })

try {
  // ---- SEC-REV-21: parent_uid is server-stamped; a forged body value is ignored ----
  const chk = await invoke('create-consent-checkout', seth.session.access_token, { nickname: 'X', gradeBand: '2', returnUrl: 'http://x.local', parent_uid: uids.dana })
  chk.status === 200 && chk.body?.parent_uid === uids.seth && chk.body?.mock === true
    ? ok('SEC-REV-21: create-consent-checkout stamps parent_uid from the caller (forged body parent_uid ignored)') : bad(`SEC-REV-21: ${JSON.stringify(chk.body)}`)
  const childChk = await invoke('create-consent-checkout', brielle.session.access_token, { nickname: 'X', returnUrl: 'http://x.local' })
  childChk.status === 403 ? ok('a child identity cannot start a consent checkout') : bad(`child checkout: ${childChk.status}`)

  // ---- the full UI flow ----
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 140)) })
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.getByRole('button', { name: /^Seth/ }).click()
  await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })

  await page.getByTestId('add-child').click()
  await page.getByLabel('Child nickname').fill('ConsentKid')
  await page.getByLabel('Grade band').fill('2')
  await page.getByRole('button', { name: /Continue to consent/ }).click()
  await page.getByTestId('payment-pending').waitFor({ timeout: 15000 })
  ok('add-a-child → consent checkout (mock) → returns to a payment-pending state')

  // Stripe would now POST the signed webhook; fire it (server-stamped parent_uid = Seth)
  const evtId = 'evt_rm14_' + Date.now()
  const wh = await postWebhook({ id: evtId, type: 'checkout.session.completed', data: { object: { id: 'cs_' + evtId, payment_intent: 'pi_' + evtId, metadata: { parent_uid: uids.seth, nickname: 'ConsentKid', grade: '2', policy_version: 'v1' } } } })
  wh === 200 ? ok('signed webhook processed → consent + child created') : bad(`webhook status ${wh}`)

  await page.getByRole('button', { name: /Practice as ConsentKid/ }).waitFor({ timeout: 30000 })
  ok('the consented child activated in the hub (payment pending → live)')
  await page.getByRole('button', { name: /Practice as ConsentKid/ }).click()
  await page.getByText('Hi, ConsentKid', { exact: false }).first().waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: /Return to parent/ }).click()
  await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })
  ok('entered the newly-consented child via the mint, then returned to parent')

  const bad2 = errs.filter((e) => !/favicon|Failed to load resource.*404/.test(e))
  bad2.length ? bad(`page errors: ${bad2.slice(0, 2).join(' | ')}`) : ok('no page errors')
  await ctx.close()
} finally {
  await browser.close(); server.kill(); fnServe.kill(); fs.rmSync(envFile, { force: true })
}
console.log(fails ? `\n=== RM-14 CONSENT E2E: ${fails} FAIL ===` : '\n=== RM-14 CONSENT E2E: ALL PASS (add-child → consent → active child → enter)')
process.exit(fails ? 1 : 0)
