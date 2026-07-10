// RM-19 visual capture — the remove-child flow (confirm loss-summary + typed
// confirmation, and the dual-layer receipt) across desktop + iPhone, for review.
// Run (stack up, dist built with VITE_ALLOW_DEV_SIGNIN=true): eval "$(supabase status -o env)"; node db/scripts/rm19-screens.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const outDir = path.join(root, 'tools', 'screens'); fs.mkdirSync(outDir, { recursive: true })
const PORT = 8151
const cfg = m3Config()
const A = FAMILY.alpha
await setupFamily(cfg)
await signInAs(cfg, A.parent.email) // warm the stack
const envFile = path.join(root, 'supabase', '.env.rm19s'); fs.writeFileSync(envFile, '# rm19s\n')
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
await new Promise((r) => setTimeout(r, 12000))
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()

const shots = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'iphone', w: 390, h: 844 },
]
try {
  for (const v of shots) {
    try {
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /^Seth/ }).click()
      await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })
      await page.getByRole('button', { name: /Remove Theo/ }).click()
      await page.getByTestId('remove-dialog').waitFor({ timeout: 8000 })
      await page.screenshot({ path: path.join(outDir, `rm19-${v.name}-confirm.png`), fullPage: true })
      await page.getByLabel("Type the child's nickname to confirm").fill('Theo')
      await page.getByTestId('confirm-delete').click()
      await page.getByTestId('deletion-receipt').waitFor({ timeout: 20000 })
      await page.getByText('Technical proof').click().catch(() => {})
      await page.screenshot({ path: path.join(outDir, `rm19-${v.name}-receipt.png`), fullPage: true })
      await ctx.close()
    } catch (e) { console.error(`  ${v.name} capture failed:`, e.message) }
  }
  console.log('screens →', outDir)
} finally {
  await browser.close(); server.kill(); fnServe.kill(); fs.rmSync(envFile, { force: true })
}
