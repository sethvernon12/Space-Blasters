// AR-3 visual capture — homeschool onboarding (lobby → "Set up my homeschool" →
// parent cockpit) + a child hub populated by the grade-level starter template.
// NON-DESTRUCTIVE. Run (stack up, dist flag-on):
//   eval "$(supabase status -o env)"; node db/scripts/rm27-screens.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY, PASSWORD } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const outDir = path.join(root, 'tools', 'screens'); fs.mkdirSync(outDir, { recursive: true })
const PORT = 8165
const NEWCOMER = 'newcomer@local.test'
const cfg = m3Config()
await setupFamily(cfg)
const admin = adminClient(cfg)
const recreateNewcomer = async () => {
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const ex = list.users.find((u) => u.email === NEWCOMER)
  if (ex) await admin.auth.admin.deleteUser(ex.id) // fresh uid → back to the lobby
  await admin.auth.admin.createUser({ email: NEWCOMER, password: PASSWORD, email_confirm: true })
}
// seed Brielle's hub with the grade-level starter template (as her parent)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
await seth.client.rpc('apply_starter_template', { p_child_id: FAMILY.alpha.children.brielle.childId })

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()
const shots = [{ name: 'desktop', w: 1440, h: 900 }, { name: 'iphone', w: 390, h: 844 }]
const shot = (page, n) => page.screenshot({ path: path.join(outDir, `ar3-${n}.png`), fullPage: true })

try {
  for (const v of shots) {
    try {
      await recreateNewcomer()
      // ---- homeschool onboarding: lobby → set up → empty parent cockpit ----
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /^Alex/ }).click()
      await page.getByTestId('lobby-homeschool-start').waitFor({ timeout: 15000 })
      await page.getByTestId('lobby-homeschool-start').click()
      await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })
      await shot(page, `${v.name}-homeschool-onboarded`) // empty roster + "Add a child"
      await ctx.close()

      // ---- child hub populated by the starter template ----
      const cctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const cpage = await cctx.newPage()
      await cpage.goto(`http://127.0.0.1:${PORT}/`)
      await cpage.getByRole('button', { name: /^Brielle/ }).click()
      await cpage.getByText('From your tutor', { exact: false }).first().waitFor({ timeout: 15000 })
      await shot(cpage, `${v.name}-child-starter`)
      await cctx.close()
    } catch (e) { console.error(`  ${v.name} capture failed:`, e.message) }
  }
  console.log('screens →', outDir)
} finally {
  await browser.close(); server.kill()
}
