// Phase 4 · U2 visual — the ChildInbox affordance in ParentHome: the camera-first
// "Add work" button + the RECIPE-BOX kit (what to shoot, format, privacy promise) +
// the empty inbox. NON-DESTRUCTIVE (no upload). Run (stack up, dist flag-on):
//   eval "$(supabase status -o env)"; node db/scripts/rm30-screens.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const outDir = path.join(root, 'tools', 'screens'); fs.mkdirSync(outDir, { recursive: true })
const PORT = 8167
const cfg = m3Config()
await setupFamily(cfg); await signInAs(cfg, FAMILY.alpha.parent.email)
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()
const shots = [{ name: 'desktop', w: 1440, h: 900 }, { name: 'iphone', w: 390, h: 844 }]
try {
  for (const v of shots) {
    try {
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /^Seth/ }).click()
      await page.getByTestId('upload-work').first().waitFor({ timeout: 15000 })
      await page.getByTestId('upload-work').first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(outDir, `ar-u2-${v.name}-inbox.png`), fullPage: true })
      await ctx.close()
    } catch (e) { console.error(`  ${v.name} capture failed:`, e.message) }
  }
  console.log('screens →', outDir)
} finally { await browser.close(); server.kill() }
