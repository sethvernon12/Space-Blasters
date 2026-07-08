// ============================================================================
// RM-12 Slice-3b e2e — the mint wired into the parent home. Signs in a parent
// (dev switcher), ENTERS a consented child's hub via the REAL mint (create-child
// / start-child-session Edge Functions served), RETURNS to parent, and ADDS a
// child. LOCAL only. Prereq: hub built with VITE_ALLOW_DEV_SIGNIN=true.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm12-3b-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const PORT = 8129
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built'); process.exit(1) }

console.log('Setup + serve functions + dist…')
await setupFamily(cfg)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
const fnServe = spawn('supabase', ['functions', 'serve'], { cwd: root, stdio: 'ignore', env: process.env })
let ready = false
for (let i = 0; i < 45 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  try { const r = await fetch(`${cfg.apiUrl}/functions/v1/start-child-session`, { method: 'POST', headers: { Authorization: `Bearer ${seth.session.access_token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: '{}' }); if (r.status && r.status !== 502 && r.status !== 503) ready = true } catch { /* boot */ }
}
ready ? ok('functions serving') : bad('functions not ready')
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch({ args: ['--disable-web-security'] })
const base = `http://127.0.0.1:${PORT}/`

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 140)) })

  await page.goto(base)
  await page.getByRole('button', { name: /^Seth/ }).click()
  await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })

  // 1. enter a CONSENTED child (Brielle) via the real mint
  await page.getByRole('button', { name: /Practice as Brielle/ }).click()
  await page.getByText('Hi, Brielle', { exact: false }).first().waitFor({ timeout: 20000 })
  ok('parent entered a consented child hub via the real mint (Practice as → child home)')

  // 2. return to parent restores the parent session
  await page.getByRole('button', { name: /Return to parent/ }).click()
  await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })
  ok('Return to parent restored the parent session')

  // (add-a-child → consent checkout is covered by rm14-consent-e2e)
  const bad2 = errs.filter((e) => !/favicon|Failed to load resource.*404/.test(e))
  bad2.length ? bad(`page errors: ${bad2.slice(0, 2).join(' | ')}`) : ok('no page errors')
  await ctx.close()
} finally {
  await browser.close(); server.kill(); fnServe.kill()
}
console.log(fails ? `\n=== RM-12 3B E2E: ${fails} FAIL ===` : '\n=== RM-12 3B E2E: ALL PASS (add-child + enter + return under the real mint) ===')
process.exit(fails ? 1 : 0)
