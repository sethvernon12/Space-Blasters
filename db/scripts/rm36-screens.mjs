// Phase 5 · 5c visual + XSS pass. Seeds three pending proposals for one child — a low-friction
// (solver agrees + clean), a high-friction (disagrees), and one whose AI feedback contains an
// XSS payload — then captures the parent's grading gate on iPhone/iPad/desktop and asserts:
//   - low-friction shows a single "Confirm grade" (enabled); high-friction shows
//     "Review & confirm" (disabled) + the escalation banner (system-signal-driven friction);
//   - the XSS feedback renders as INERT text (no element injected, onerror never fires).
// Run (stack up, dist built): eval "$(supabase status -o env)"; node db/scripts/rm36-screens.mjs
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
const PORT = 8171
const cfg = m3Config()
const BRIELLE = FAMILY.alpha.children.brielle.childId
let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()

const uids = await setupFamily(cfg)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seed = async ({ read, clean = true, feedback }) => {
  const p = `${BRIELLE}/${uuid()}.jpg`
  const up = (await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
                       values ($1::uuid,$2::uuid,'parent',$3,'image/jpeg',1000,$4,'inbox') returning id`, [BRIELLE, seth.uid, p, clean]))[0].id
  const job = (await q(`insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, reserved_cost, client_job_id, status)
                        values ($1::uuid,$2::uuid,'mult2','{"operator":"mul","a":6,"b":7}'::jsonb,1,$3::uuid,'proposed') returning id`, [BRIELLE, up, uuid()]))[0].id
  await q(`insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, confidence, feedback, provider, model_version)
           values ($1::uuid,$2::uuid,$3::uuid,'mult2',$4,0.95,$5,'local','local-reader-v1')`, [job, BRIELLE, up, read, feedback])
}
await seed({ read: 42, clean: true, feedback: 'Great — that’s correct!' })                              // low friction
await seed({ read: 41, clean: true, feedback: 'Looks off — please check.' })                            // high friction (disagree)
await seed({ read: 42, clean: true, feedback: '<img src=x onerror="window.__xss_fired=true">bad' })     // XSS payload
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
      await page.getByRole('button', { name: /^Seth/ }).click()
      await page.getByTestId('grade-proposals').first().waitFor({ timeout: 20000 })
      await page.getByTestId('grade-proposals').first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(outDir, `ar-5c-${v.name}-grading.png`), fullPage: true })

      if (v.name === 'desktop') {
        const cards = page.getByTestId('grade-review-card')
        const n = await cards.count()
        n >= 3 ? ok(`renders ${n} review cards`) : bad(`cards: ${n}`)
        // low-friction card: a "Confirm grade" that is enabled
        const confirmBtns = page.getByTestId('confirm-grade')
        const texts = await confirmBtns.allInnerTexts()
        const disabledFlags = await confirmBtns.evaluateAll((els) => els.map((e) => e.disabled))
        const lowIdx = texts.findIndex((t) => /Confirm grade/.test(t))
        const highIdx = texts.findIndex((t) => /Review & confirm/.test(t))
        lowIdx >= 0 && disabledFlags[lowIdx] === false ? ok('low-friction: single “Confirm grade”, enabled') : bad(`low: ${JSON.stringify({ texts, disabledFlags })}`)
        highIdx >= 0 && disabledFlags[highIdx] === true ? ok('high-friction: “Review & confirm”, DISABLED until review/correct/ack') : bad(`high: ${JSON.stringify({ texts, disabledFlags })}`)
        ;(await page.getByTestId('friction-escalated').count()) >= 1 ? ok('escalation banner shown for the high-risk proposal') : bad('no escalation banner')
        // XSS: the payload rendered inert (no element injected, onerror never fired)
        const xssFired = await page.evaluate(() => Boolean(window.__xss_fired))
        const feedbackText = (await page.getByTestId('ai-feedback').allInnerTexts()).join('\n')
        !xssFired && feedbackText.includes('<img') ? ok('XSS-safe: AI feedback renders as INERT text (onerror never fired; markup shown literally)') : bad(`xss: fired=${xssFired} text=${feedbackText.slice(0, 80)}`)
      }
      await ctx.close()
    } catch (e) { bad(`${v.name}: ${e.message}`) }
  }
  console.log('screens →', outDir)
} finally { await browser.close(); server.kill() }
console.log(fails ? `\n=== RM-36 SCREENS: ${fails} FAIL ===` : '\n=== RM-36 SCREENS: ALL PASS (friction from system signals; low=1-tap enabled, high=disabled+banner; XSS-safe render) ===')
process.exit(fails ? 1 : 0)
