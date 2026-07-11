// ============================================================================
// RM-22 delete-account UI e2e (Slice B3/B4) — the parent-facing WHOLE-ACCOUNT
// deletion, end to end through the REAL delete-account Edge function.
//   1. danger zone → typed-phrase confirmation → deletes; the dual-layer ACCOUNT
//      receipt (hash + child count) renders and downloads; the parent is signed out.
//   2. DB: every child purged via the kernel, an immutable opaque account receipt,
//      the parent + child GoTrue users deleted, the other family untouched.
// Prereq: hub built with VITE_ALLOW_DEV_SIGNIN=true.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm22-delete-account-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import pgpkg from 'pg'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY } from './family.mjs'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const PORT = 8160
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built (VITE_ALLOW_DEV_SIGNIN=true)'); process.exit(1) }

console.log('Setup + serve delete-account + dist…')
const uids = await setupFamily(cfg)
const db = new Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)
const seth = await signInAs(cfg, A.parent.email)
const envFile = path.join(root, 'supabase', '.env.rm22'); fs.writeFileSync(envFile, '# rm22\n')
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const invoke = async (token, fn, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
// readiness: probe delete-child with an EMPTY body (400, NON-destructive). NEVER
// probe delete-account with a valid token — empty body deletes the whole account.
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke(seth.session.access_token, 'delete-child', {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('function not ready')
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch({ args: ['--disable-web-security'] })
const userExists = async (id) => !!(await admin.auth.admin.getUserById(id)).data?.user

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.getByRole('button', { name: /^Seth/ }).click()
  await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })

  // Delete my account now lives on the My account page (account menu → My account).
  await page.getByTestId('account-menu').click()
  await page.getByTestId('nav-my-account').click()
  await page.getByTestId('delete-account').click()
  await page.getByTestId('delete-account-dialog').waitFor({ timeout: 8000 })
  const btn = page.getByTestId('confirm-delete-account')
  const disabledBefore = await btn.isDisabled()
  await page.getByLabel('Type the confirmation phrase').fill('delete my account')
  const enabledAfter = !(await btn.isDisabled())
  disabledBefore && enabledAfter ? ok('account delete is gated until the exact phrase is typed') : bad(`confirm gate: before=${disabledBefore} after=${enabledAfter}`)

  await btn.click()
  await page.getByTestId('account-deletion-receipt').waitFor({ timeout: 20000 })
  const rtext = await page.getByTestId('account-deletion-receipt').textContent()
  rtext.match(/[0-9a-f]{64}/) && /2 child profiles/.test(rtext) ? ok('dual-layer ACCOUNT receipt shown (64-char hash + 2 children)') : bad(`receipt text: ${rtext?.slice(0, 120)}`)

  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.getByTestId('download-account-receipt').click()])
  ;/^account-deletion-receipt-.*\.json$/.test(dl.suggestedFilename()) ? ok(`account receipt downloads (${dl.suggestedFilename()})`) : bad(`download name: ${dl.suggestedFilename()}`)

  await page.getByTestId('account-done').click() // signs out
  await page.getByRole('button', { name: /^Seth/ }).waitFor({ timeout: 8000 }) // back on the sign-in switcher
  ok('after deletion the parent is signed out (back on the sign-in screen)')

  // ---- DB: whole account purged via the kernel; other family intact ----
  const sethKids = (await q(`select count(*)::int n from public.children where parent_id=$1`, [uids.seth]))[0].n === 0
  const acct = (await q(`select status, child_count, (r::text ilike '%Brielle%' or r::text ilike '%Theo%') leak from public.account_deletion_receipts r where parent_id=$1`, [uids.seth]))[0]
  const usersGone = !(await userExists(uids.seth)) && !(await userExists(uids.brielle)) && !(await userExists(uids.theo))
  const wren = (await q(`select count(*)::int n from public.children where id=$1`, [CID.Wren]))[0].n === 1
  const stragglers = (await q(`select count(*)::int n from public.account_deletion_receipts where status='pending_auth_cleanup'`))[0].n === 0
  sethKids && acct?.status === 'completed' && acct?.child_count === 2 && !acct?.leak && usersGone && wren && stragglers
    ? ok('account purged via kernel: 2 children gone, opaque completed receipt, parent+child GoTrue users deleted, other family untouched, no stragglers')
    : bad(`db: sethKids=${sethKids} acct=${JSON.stringify(acct)} usersGone=${usersGone} wren=${wren} stragglers=${stragglers}`)

  const bad2 = errs.filter((e) => !/favicon|Failed to load resource.*404/.test(e))
  bad2.length ? bad(`page errors: ${bad2.slice(0, 2).join(' | ')}`) : ok('no page errors')
  await ctx.close()
} finally {
  await browser.close(); server.kill(); fnServe.kill(); await db.end(); fs.rmSync(envFile, { force: true })
}
console.log(fails ? `\n=== RM-22 DELETE-ACCOUNT: ${fails} FAIL ===` : '\n=== RM-22 DELETE-ACCOUNT: ALL PASS (typed-phrase confirm; account receipt; signed out; kernel purge) ===')
process.exit(fails ? 1 : 0)
