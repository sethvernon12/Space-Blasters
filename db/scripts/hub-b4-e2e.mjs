// ============================================================================
// B4 hub e2e — drives the BUILT hub (dist/, pointed at the local stack) as each
// role via the dev "Sign in as…" switcher, and screenshots at iPad 390x844 +
// desktop 1440x900. Seeds a real practice set for Brielle first so the homes
// show real numbers. LOCAL only; the hub client uses anon key + user JWT (RLS).
//
// Prereq: build with the local env first — `npm --prefix hub run build`.
// Run: eval "$(supabase status -o env)"; node db/scripts/hub-b4-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const shots = path.join(root, 'hub', 'screens')
fs.mkdirSync(shots, { recursive: true })
const PORT = 8123
const uuid = () => crypto.randomUUID()
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built — run `npm --prefix hub run build` first'); process.exit(1) }

const cfg = m3Config()
console.log('Seeding family + a real set for Brielle…')
await setupFamily(cfg)
{
  const brielle = await signInAs(cfg, FAMILY.alpha.children.brielle.email)
  const session = uuid()
  const evs = Array.from({ length: 8 }, (_, i) => ({
    clientAttemptId: uuid(), clientSessionId: session, stageIndex: 0, skill: 'addition',
    result: i === 5 ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5,
    chosenAnswer: i === 5 ? 4 : 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null,
    runTimeS: i * 4, level: 1, mode: 'journey', context: { source: 'b4-seed' },
  }))
  const { data } = await brielle.client.rpc('record_attempts_authed', { p_child_id: FAMILY.alpha.children.brielle.childId, p_batch: buildBatch(evs) })
  data?.inserted === 8 ? ok('Brielle has real add5 mastery (7/8)') : bad(`seed record: ${JSON.stringify(data)}`)
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch({ args: ['--disable-web-security'] })
const base = `http://127.0.0.1:${PORT}/`

async function shot(role, label, w, h, drive) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800 })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(base)
  await page.getByRole('button', { name: role.btn }).click()
  await page.getByText(role.ready, { exact: false }).first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(700)
  if (drive) await drive(page)
  await page.screenshot({ path: `${shots}/hub-${role.key}-${label}.png`, fullPage: true })
  errs.length ? bad(`${role.key} ${label}: page errors: ${errs.join('; ')}`) : ok(`${role.key} ${label}: rendered, no errors`)
  await ctx.close()
}

const ROLES = {
  parent: { key: 'parent', btn: /^Seth/, ready: 'Your children' },
  child: { key: 'child', btn: /^Brielle/, ready: 'Hi, Brielle' },
  tutor: { key: 'tutor', btn: /Grandma Rose/, ready: 'Students you help' },
}

try {
  // sign-in switcher itself
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await ctx.newPage(); await page.goto(base)
    await page.getByText('choose who').first().waitFor({ timeout: 8000 })
    await page.screenshot({ path: `${shots}/hub-signin-390.png`, fullPage: true }); ok('sign-in switcher rendered')
    await ctx.close()
  }
  for (const r of [ROLES.parent, ROLES.child, ROLES.tutor]) {
    await shot(r, '390', 390, 844)
    await shot(r, '1440', 1440, 900)
  }
  // Brielle drives the practice module → done state
  await shot(ROLES.child, 'practice-390', 390, 844, async (page) => {
    await page.getByRole('button', { name: /Practice Math/ }).click()
    for (let i = 0; i < 5; i++) {
      await page.locator('.text-6xl').first().waitFor({ timeout: 8000 })
      const txt = (await page.locator('.text-6xl').first().innerText()).trim()
      const [a, b] = txt.split('+').map((x) => parseInt(x.trim(), 10))
      const ans = String(a + b)
      const opts = page.locator('div.grid.grid-cols-2 > button')
      const n = await opts.count()
      for (let j = 0; j < n; j++) { if ((await opts.nth(j).innerText()).trim() === ans) { await opts.nth(j).click(); break } }
      await page.waitForTimeout(460)
    }
    await page.getByText('Great work', { exact: false }).first().waitFor({ timeout: 8000 })
    await page.waitForTimeout(400)
  })
} finally {
  await browser.close()
  server.kill()
}
console.log(fails ? `\nB4 E2E: ${fails} FAIL` : '\nB4 E2E: ALL PASS')
process.exit(fails ? 1 : 0)
