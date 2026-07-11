// AR-2 lobby + first-run router e2e + screens. A brand-new signed-in adult (no
// children, no grants) must land in the ZERO-PRIVILEGE lobby — NOT auto-promoted
// to a parent-with-access — while existing parent/child/tutor sessions bypass it.
// Also proves the lobby confers no DATA access (RLS: newcomer reads 0 children).
// Run (stack up, dist built flag-on): eval "$(supabase status -o env)"; node db/scripts/rm26-lobby-e2e.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, PASSWORD } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const outDir = path.join(root, 'tools', 'screens'); fs.mkdirSync(outDir, { recursive: true })
const PORT = 8164
const NEWCOMER = 'newcomer@local.test'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

const cfg = m3Config()
console.log('Setup + mint a brand-new adult (no children)…')
await setupFamily(cfg)
const admin = adminClient(cfg)
{ // delete-then-create the newcomer for a deterministic fresh, childless adult
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const ex = list.users.find((u) => u.email === NEWCOMER)
  if (ex) await admin.auth.admin.deleteUser(ex.id)
  const { error } = await admin.auth.admin.createUser({ email: NEWCOMER, password: PASSWORD, email_confirm: true })
  if (error) throw new Error(`create newcomer: ${error.message}`)
}

// ---- data-layer zero-privilege: the newcomer reads NO children / NO grants ----
const nc = await signInAs(cfg, NEWCOMER)
const { data: kids } = await nc.client.from('children').select('id')
const { data: grants } = await nc.client.from('tutor_grants').select('child_id').then((r) => r).catch(() => ({ data: null }))
;(Array.isArray(kids) && kids.length === 0) ? ok('newcomer reads 0 children (RLS zero-privilege)') : bad(`newcomer sees ${kids?.length} children`)
;(grants == null || grants.length === 0) ? ok('newcomer holds 0 active grants') : bad(`newcomer has ${grants?.length} grants`)

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()
const shot = (page, n) => page.screenshot({ path: path.join(outDir, `ar2-${n}.png`), fullPage: true })

try {
  // ---- newcomer → LOBBY (not ParentHome) ----
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const perr = []; page.on('pageerror', (e) => perr.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.getByRole('button', { name: /^Alex/ }).click()
  await page.getByTestId('lobby').waitFor({ timeout: 15000 })
  ok('newcomer lands in the LOBBY')
  const sawChildren = await page.getByText('Your children', { exact: false }).count()
  sawChildren === 0 ? ok('lobby shows NO parent cockpit ("Your children" absent)') : bad('lobby leaked the parent cockpit')
  const hasAcademy = await page.getByTestId('lobby-academy').count()
  const hasHomeschool = await page.getByTestId('lobby-homeschool').count()
  ;(hasAcademy && hasHomeschool) ? ok('both never-mixed paths presented (Academy + Homeschool)') : bad('a lobby path is missing')
  await shot(page, 'desktop-lobby')
  await page.getByTestId('lobby-academy-open').click()
  await page.getByTestId('lobby-academy-key').waitFor({ timeout: 4000 })
  await page.getByTestId('lobby-homeschool-open').click()
  await page.getByTestId('lobby-homeschool-note').waitFor({ timeout: 4000 })
  await shot(page, 'desktop-lobby-paths')
  await ctx.close()

  // iphone lobby
  const ictx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const ipage = await ictx.newPage()
  await ipage.goto(`http://127.0.0.1:${PORT}/`)
  await ipage.getByRole('button', { name: /^Alex/ }).click()
  await ipage.getByTestId('lobby').waitFor({ timeout: 15000 })
  await shot(ipage, 'iphone-lobby')
  await ictx.close()

  // ---- existing roles BYPASS the lobby ----
  for (const [who, name, expect] of [['Seth', /^Seth/, 'Your children'], ['Brielle', /^Brielle/, 'Hi, Brielle']]) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const p = await c.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await p.getByRole('button', { name }).click()
    await p.getByText(expect, { exact: false }).first().waitFor({ timeout: 15000 })
    const lobbyLeak = await p.getByTestId('lobby').count()
    lobbyLeak === 0 ? ok(`${who} bypasses the lobby → their own home ("${expect}")`) : bad(`${who} wrongly saw the lobby`)
    await c.close()
  }
  perr.length === 0 ? ok('no page errors') : bad(`page errors: ${perr.join('; ')}`)
} finally {
  await browser.close(); server.kill()
}
console.log(fails ? `\n=== RM-26 LOBBY: ${fails} FAIL ===` : '\n=== RM-26 LOBBY: ALL PASS (new adult → zero-privilege lobby; existing roles bypass) ===')
process.exit(fails ? 1 : 0)
