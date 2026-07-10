// ============================================================================
// RM-19 remove-child e2e (Slice B1) — the parent-facing consent-revocation ->
// hard-deletion UI, end to end through the REAL delete-child Edge function.
//   1. parent opens Remove for a child, sees the loss summary, must TYPE the
//      nickname to confirm, deletes -> the dual-layer receipt (hash + disposition)
//      renders and downloads; the roster drops the child.
//   2. DB: the child is purged, an immutable receipt + consent revoke remain,
//      the sibling + other family are untouched.
//   3. a child deleted MID-SESSION gets the gentle "time for a break" screen, not
//      an error.
// Prereq: hub built with VITE_ALLOW_DEV_SIGNIN=true.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm19-remove-child-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import pgpkg from 'pg'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const PORT = 8150
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built (VITE_ALLOW_DEV_SIGNIN=true)'); process.exit(1) }

console.log('Setup + serve delete-child + dist…')
const uids = await setupFamily(cfg)
const db = new Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const envFile = path.join(root, 'supabase', '.env.rm19'); fs.writeFileSync(envFile, `# rm19\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const invoke = async (token, fn, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
let ready = false
const seth0 = await signInAs(cfg, A.parent.email)
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke(seth0.session.access_token, 'delete-child', {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('delete-child serving') : bad('function not ready')
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch({ args: ['--disable-web-security'] })
const childCount = async (id) => (await q(`select count(*)::int n from public.children where id=$1`, [id]))[0].n

try {
  // ---- 1. parent removes Theo through the UI ----
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctxA.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.getByRole('button', { name: /^Seth/ }).click()
  await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })

  await page.getByRole('button', { name: /Remove Theo/ }).click()
  await page.getByTestId('remove-dialog').waitFor({ timeout: 8000 })
  // the delete button is gated on typing the exact nickname
  const btn = page.getByTestId('confirm-delete')
  const disabledBefore = await btn.isDisabled()
  await page.getByLabel("Type the child's nickname to confirm").fill('Theo')
  const enabledAfter = !(await btn.isDisabled())
  disabledBefore && enabledAfter ? ok('delete is gated until the nickname is typed exactly') : bad(`confirm gate: before=${disabledBefore} after=${enabledAfter}`)

  await btn.click()
  await page.getByTestId('deletion-receipt').waitFor({ timeout: 20000 })
  const hashText = await page.getByTestId('deletion-receipt').textContent() // includes the collapsed technical annex
  hashText.match(/[0-9a-f]{64}/) ? ok('dual-layer receipt shown with the 64-char receipt hash') : bad('receipt hash not present')

  // download the off-DB receipt anchor
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.getByTestId('download-receipt').click()])
  ;/^deletion-receipt-.*\.json$/.test(dl.suggestedFilename()) ? ok(`receipt downloads (${dl.suggestedFilename()})`) : bad(`download name: ${dl.suggestedFilename()}`)

  await page.getByRole('button', { name: /^Done/ }).click()
  await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 8000 })
  await new Promise((r) => setTimeout(r, 500))
  const theoGoneUi = !(await page.getByText(/Practice as Theo/).count())
  theoGoneUi ? ok('roster drops Theo after deletion') : bad('Theo still on the roster')

  // ---- 2. DB: Theo purged; evidence retained; siblings + other family intact ----
  const theoGone = await childCount(CID.Theo) === 0
  const receipt = (await q(`select status, receipt_hash from public.deletion_receipts where child_id=$1`, [CID.Theo]))[0]
  const revoke = (await q(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='revoke'`, [CID.Theo]))[0].n
  const brielle = await childCount(CID.Brielle), wren = await childCount(CID.Wren)
  theoGone && receipt?.receipt_hash?.length === 64 && revoke === 1 && brielle === 1 && wren === 1
    ? ok('Theo purged; immutable receipt + revoke retained; Brielle + Wren untouched')
    : bad(`db: theoGone=${theoGone} receipt=${JSON.stringify(receipt)} revoke=${revoke} brielle=${brielle} wren=${wren}`)

  // ---- 3. child deleted mid-session -> gentle screen ----
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const kidPage = await ctxB.newPage()
  await kidPage.goto(`http://127.0.0.1:${PORT}/`)
  await kidPage.getByRole('button', { name: /^Brielle/ }).click()
  await kidPage.getByText('Hi, Brielle', { exact: false }).first().waitFor({ timeout: 15000 })
  ok('child (Brielle) is in her hub')
  // parent deletes Brielle out from under the live child session
  const seth = await signInAs(cfg, A.parent.email)
  const del = await invoke(seth.session.access_token, 'delete-child', { childId: CID.Brielle })
  del.status === 200 && del.body?.ok ? ok('parent deleted Brielle (mid-session)') : bad(`delete Brielle: ${JSON.stringify(del)}`)
  // mid-session (NO reload): the live check fires on tab focus (and a heartbeat)
  await kidPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await kidPage.getByTestId('child-removed').waitFor({ timeout: 20000 })
  ok('the removed child sees the gentle “time for a break” screen mid-session (no reload), not an error')

  const bad2 = errs.filter((e) => !/favicon|Failed to load resource.*404/.test(e))
  bad2.length ? bad(`page errors: ${bad2.slice(0, 2).join(' | ')}`) : ok('no page errors')
  await ctxA.close(); await ctxB.close()
} finally {
  await browser.close(); server.kill(); fnServe.kill(); await db.end(); fs.rmSync(envFile, { force: true })
}
console.log(fails ? `\n=== RM-19 REMOVE-CHILD: ${fails} FAIL ===` : '\n=== RM-19 REMOVE-CHILD: ALL PASS (revoke→delete UI; dual-layer receipt; gentle child screen) ===')
process.exit(fails ? 1 : 0)
