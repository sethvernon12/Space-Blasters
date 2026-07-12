// Phase 4 · U3b visual — the inbox status lifecycle control (parent) + the tutor's
// inbox on a granted child. Seeds one upload row (service) so the control renders; the
// signed-URL thumbnail is a placeholder locally (storage origin unreachable from the host).
// Run (stack up, dist flag-on): eval "$(supabase status -o env)"; node db/scripts/rm32-screens.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const outDir = path.join(root, 'tools', 'screens'); fs.mkdirSync(outDir, { recursive: true })
const PORT = 8168
const cfg = m3Config()
const BRIELLE = FAMILY.alpha.children.brielle.childId
await setupFamily(cfg)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
// seed a couple of inbox items via a superuser pg connection (client + service direct
// writes are blocked by design — writes go through the definer RPC in the app)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
await db.query(
  `insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status, note) values
   ($1::uuid,$2::uuid,'parent',$1::text||'/seed1.jpg','image/jpeg',1000,true,'inbox',null),
   ($1::uuid,$2::uuid,'parent',$1::text||'/seed2.jpg','image/jpeg',1000,true,'graded','worksheet p.3')`,
  [BRIELLE, seth.uid])
await db.end()

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()
const shots = [{ name: 'desktop', w: 1440, h: 900 }, { name: 'iphone', w: 390, h: 844 }]
try {
  for (const v of shots) {
    try {
      // parent: inbox with status controls
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /^Seth/ }).click()
      await page.getByTestId('inbox-items').first().waitFor({ timeout: 15000 })
      await page.getByTestId('inbox-items').first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(outDir, `ar-u3b-${v.name}-parent-inbox.png`), fullPage: true })
      await ctx.close()

      // tutor: granted child's inbox (can-teach → upload + status)
      const tctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const tpage = await tctx.newPage()
      await tpage.goto(`http://127.0.0.1:${PORT}/`)
      await tpage.getByRole('button', { name: /^Grandma Rose/ }).click()
      await tpage.getByTestId('inbox-items').first().waitFor({ timeout: 15000 })
      await tpage.getByTestId('inbox-items').first().scrollIntoViewIfNeeded()
      await tpage.screenshot({ path: path.join(outDir, `ar-u3b-${v.name}-tutor-inbox.png`), fullPage: true })
      await tctx.close()
    } catch (e) { console.error(`  ${v.name} capture failed:`, e.message) }
  }
  console.log('screens →', outDir)
} finally { await browser.close(); server.kill() }
