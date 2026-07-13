// Phase 5 · 5d visual + XSS pass. Seeds two moderated sent-to-child notes for the child —
// one benign, one carrying an XSS payload — then signs in AS THE CHILD (Brielle), lands on
// ChildHome, captures the "Notes on my work" panel on iPhone/iPad/desktop, and asserts the
// notes render as INERT text (no element injected, onerror never fires).
// Run (stack up, dist built): eval "$(supabase status -o env)"; node db/scripts/rm37-screens.mjs
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
const PORT = 8172
const cfg = m3Config()
const BRIELLE = FAMILY.alpha.children.brielle.childId
let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()

const uids = await setupFamily(cfg)
await signInAs(cfg, FAMILY.alpha.parent.email)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seedNote = (feedback) => q(`insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, target_kind, target_id, visibility_scope)
  values ($1::uuid,$2::uuid,'parent','feedback','math',jsonb_build_object('feedback',$3::text),'upload',$4::uuid,'sent-to-child')`, [BRIELLE, uids.seth, feedback, uuid()])
await seedNote('Great job on your multiplication — keep it up! 🎉')
await seedNote('<img src=x onerror="window.__xss_fired=true">see me')
await db.end()

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()
const shots = [{ name: 'iphone', w: 390, h: 844 }, { name: 'ipad', w: 820, h: 1180 }, { name: 'desktop', w: 1440, h: 900 }]
try {
  for (const v of shots) {
    try {
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /^Brielle/ }).click()   // sign in AS THE CHILD
      await page.getByTestId('child-feedback').waitFor({ timeout: 20000 })
      await page.getByTestId('child-feedback').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(outDir, `ar-5d-${v.name}-child-feedback.png`), fullPage: true })

      if (v.name === 'desktop') {
        const notes = page.getByTestId('feedback-note')
        ;(await notes.count()) >= 2 ? ok('child sees the moderated notes') : bad(`notes: ${await notes.count()}`)
        const xssFired = await page.evaluate(() => Boolean(window.__xss_fired))
        const text = (await notes.allInnerTexts()).join('\n')
        !xssFired && text.includes('<img') ? ok('XSS-safe: the note renders as INERT text (onerror never fired; markup shown literally)') : bad(`xss: fired=${xssFired} text=${text.slice(0, 80)}`)
        // the child view must NOT expose any adult grading control
        ;(await page.getByTestId('grade-review-card').count()) === 0 && (await page.getByTestId('confirm-grade').count()) === 0
          ? ok('SAF: no grading/confirm control on the child view — only the moderated note') : bad('child view exposed a grading control')
      }
      await ctx.close()
    } catch (e) { bad(`${v.name}: ${e.message}`) }
  }
  console.log('screens →', outDir)
} finally { await browser.close(); server.kill() }
console.log(fails ? `\n=== RM-37 SCREENS: ${fails} FAIL ===` : '\n=== RM-37 SCREENS: ALL PASS (child sees only moderated notes; XSS-inert; no grading control) ===')
process.exit(fails ? 1 : 0)
