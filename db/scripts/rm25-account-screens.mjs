// AR-1 visual capture — the account menu + My account page + relocated
// "Delete my account", across desktop + iPhone, for review. NON-DESTRUCTIVE
// (never actually deletes). Pure UI, so no Edge functions are served.
// Run (stack up, dist built with VITE_ALLOW_DEV_SIGNIN=true):
//   eval "$(supabase status -o env)"; node db/scripts/rm25-account-screens.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const outDir = path.join(root, 'tools', 'screens'); fs.mkdirSync(outDir, { recursive: true })
const PORT = 8163
const cfg = m3Config()
await setupFamily(cfg); await signInAs(cfg, FAMILY.alpha.parent.email)

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()
const shots = [{ name: 'desktop', w: 1440, h: 900 }, { name: 'iphone', w: 390, h: 844 }]
const shot = (page, n) => page.screenshot({ path: path.join(outDir, `ar1-${n}.png`), fullPage: true })

try {
  for (const v of shots) {
    try {
      // ---- parent: home → account menu → My account (with danger zone) ----
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /^Seth/ }).click()
      await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })
      await shot(page, `${v.name}-parent-home`)                 // real name in the header menu
      await page.getByTestId('account-menu').click()
      await page.getByTestId('nav-my-account').waitFor({ timeout: 5000 })
      await shot(page, `${v.name}-parent-menu-open`)            // My account + Sign out
      await page.getByTestId('nav-my-account').click()
      await page.getByTestId('delete-account').waitFor({ timeout: 5000 })
      await shot(page, `${v.name}-parent-my-account`)           // identity + Sign out + Danger zone
      await ctx.close()

      // ---- child: My account has NO danger zone, and "Return to parent" ----
      const cctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const cpage = await cctx.newPage()
      await cpage.goto(`http://127.0.0.1:${PORT}/`)
      await cpage.getByRole('button', { name: /^Brielle/ }).click()
      await cpage.getByText('Hi, Brielle', { exact: false }).first().waitFor({ timeout: 15000 })
      await cpage.getByTestId('account-menu').click()
      await cpage.getByTestId('nav-my-account').click()
      await cpage.getByText('My account', { exact: true }).waitFor({ timeout: 5000 })
      const hasDanger = await cpage.getByTestId('delete-account').count()
      console.log(`  ${v.name}: child My account danger-zone present = ${hasDanger} (expect 0)`)
      await shot(cpage, `${v.name}-child-my-account`)
      await cctx.close()
    } catch (e) { console.error(`  ${v.name} capture failed:`, e.message) }
  }
  console.log('screens →', outDir)
} finally {
  await browser.close(); server.kill()
}
