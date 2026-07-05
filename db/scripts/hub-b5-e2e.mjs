// ============================================================================
// B5 — the formal Milestone-3 close. Drives the BUILT hub (dist/, local stack)
// as each role and ASSERTS the rendered UI shows correctly-scoped data (not just
// that it renders), then DB-level per-family checks confirm nothing leaked and
// the UI writes landed on the right child. LOCAL only; hub client = anon key +
// user JWT (RLS). Service key is seed/test-only.
//
// Prereq: build first — `npm --prefix hub run build` (local .env.local).
// Run: eval "$(supabase status -o env)"; node db/scripts/hub-b5-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const PORT = 8124
const uuid = () => crypto.randomUUID()
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

const CID = { Brielle: FAMILY.alpha.children.brielle.childId, Theo: FAMILY.alpha.children.theo.childId, Wren: FAMILY.beta.children.wren.childId }
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built — run `npm --prefix hub run build` first'); process.exit(1) }

const cfg = m3Config()
console.log('Seed: Brielle 7/8 (8 attempts), Wren 4/4 (other family) — Theo none…')
const uids = await setupFamily(cfg)
async function record(email, childId, n, wrongAt) {
  const s = await signInAs(cfg, email)
  const session = uuid()
  const evs = Array.from({ length: n }, (_, i) => ({
    clientAttemptId: uuid(), clientSessionId: session, stageIndex: 0, skill: 'addition',
    result: i === wrongAt ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5,
    chosenAnswer: i === wrongAt ? 4 : 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null,
    runTimeS: i * 4, level: 1, mode: 'journey', context: { source: 'b5-seed' },
  }))
  await s.client.rpc('record_attempts_authed', { p_child_id: childId, p_batch: buildBatch(evs) })
}
await record(FAMILY.alpha.children.brielle.email, CID.Brielle, 8, 5)
await record(FAMILY.beta.children.wren.email, CID.Wren, 4, -1)

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch({ args: ['--disable-web-security'] })
const base = `http://127.0.0.1:${PORT}/`

async function open(btn, ready) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(base)
  await page.getByRole('button', { name: btn }).click()
  await page.getByText(ready, { exact: false }).first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(700)
  return { ctx, page, errs }
}
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')

try {
  // ---- PARENT (Seth): sees both his kids + Brielle's real numbers; NEVER Wren ----
  console.log('PARENT (Seth):')
  {
    const { ctx, page, errs } = await open(/^Seth/, 'Your children')
    const t = await bodyText(page)
    t.includes('Brielle') && t.includes('Theo') ? ok('sees both his children (Brielle + Theo)') : bad(`missing a child: ${t.slice(0, 120)}`)
    t.includes('80%') && t.includes('7/8') ? ok("shows Brielle's real mastery (80% · 7/8)") : bad('missing Brielle real numbers')
    t.includes('No practice recorded yet') ? ok('Theo honestly shows no practice (0%)') : bad('Theo state wrong')
    !t.includes('Wren') ? ok('does NOT show Wren (other family)') : bad('LEAK: Wren visible to Seth')
    errs.length ? bad(`page errors: ${errs.join(';')}`) : ok('no page errors')
    await ctx.close()
  }

  // ---- CHILD (Brielle): her own home + numbers; never siblings/other family ----
  console.log('CHILD (Brielle):')
  {
    const { ctx, page, errs } = await open(/^Brielle/, 'Hi, Brielle')
    const t = await bodyText(page)
    t.includes('80%') && t.includes('7/8') ? ok('sees her own real mastery (80% · 7/8)') : bad('missing her numbers')
    !t.includes('Theo') && !t.includes('Wren') ? ok('does NOT show Theo or Wren') : bad('LEAK: sibling/other-family visible to Brielle')
    // drive her practice module -> records to HER child via her session
    await page.getByRole('button', { name: /Practice Math/ }).click()
    for (let i = 0; i < 5; i++) {
      await page.locator('.text-6xl').first().waitFor({ timeout: 8000 })
      const [a, b] = (await page.locator('.text-6xl').first().innerText()).trim().split('+').map((x) => parseInt(x.trim(), 10))
      const opts = page.locator('div.grid.grid-cols-2 > button')
      const n = await opts.count()
      for (let j = 0; j < n; j++) { if ((await opts.nth(j).innerText()).trim() === String(a + b)) { await opts.nth(j).click(); break } }
      await page.waitForTimeout(460)
    }
    await page.getByText('answers recorded', { exact: false }).first().waitFor({ timeout: 8000 })
    ok('practice module recorded her set through the UI')
    errs.length ? bad(`page errors: ${errs.join(';')}`) : ok('no page errors')
    await ctx.close()
  }

  // ---- TUTOR (Rose): only Brielle; can assign + grade; never Theo/Wren ----
  console.log('TUTOR (Rose):')
  {
    const { ctx, page, errs } = await open(/Grandma Rose/, 'Students you help')
    const t = await bodyText(page)
    t.includes('Brielle') && t.includes('Can teach') ? ok('sees Brielle with "Can teach"') : bad('Brielle/Can-teach missing')
    !t.includes('Theo') && !t.includes('Wren') ? ok('does NOT show Theo or Wren') : bad('LEAK: non-granted child visible to Rose')
    await page.getByRole('button', { name: /^Assign$/ }).click()
    await page.getByText('Assignment sent', { exact: false }).first().waitFor({ timeout: 8000 })
    ok('assigned for Brielle via the UI (flash confirmed)')
    await page.getByRole('button', { name: /Mark reviewed/ }).click()
    await page.getByText('Marked', { exact: false }).first().waitFor({ timeout: 8000 })
    ok('graded (teaching_artifact) for Brielle via the UI')
    errs.length ? bad(`page errors: ${errs.join(';')}`) : ok('no page errors')
    await ctx.close()
  }

  // ---- DB-LEVEL per-family checks (test-side pg): the UI writes landed scoped ----
  console.log('DB per-family checks:')
  const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
  try {
    const cnt = async (cid) => (await c.query(`select count(*)::int n from public.attempts where child_id=$1`, [cid])).rows[0].n
    const bn = await cnt(CID.Brielle), wn = await cnt(CID.Wren), tn = await cnt(CID.Theo)
    bn === 13 ? ok(`Brielle attempts = 13 (8 seed + 5 from the UI practice)`) : bad(`Brielle attempts = ${bn} (want 13)`)
    wn === 4 && tn === 0 ? ok(`Wren = 4 (untouched), Theo = 0 — the UI practice hit only Brielle`) : bad(`Wren=${wn} Theo=${tn}`)

    const asg = (await c.query(`select child_id from public.assignments where assigned_by=$1`, [uids.rose])).rows
    asg.length >= 1 && asg.every((r) => r.child_id === CID.Brielle) ? ok(`Rose's assignments (${asg.length}) are ALL on Brielle — none on Theo/Wren`) : bad(`Rose assignment leak: ${JSON.stringify(asg)}`)

    const art = (await c.query(`select child_id, kind from public.teaching_artifacts where author_id=$1`, [uids.rose])).rows
    art.length >= 1 && art.every((r) => r.child_id === CID.Brielle) ? ok(`Rose's teaching artifacts (${art.length}) are ALL on Brielle`) : bad(`Rose artifact leak: ${JSON.stringify(art)}`)

    // global: no attempt/assignment/artifact references a child outside its own family via a wrong author
    const cross = (await c.query(
      `select count(*)::int n from public.assignments a join public.children ch on ch.id=a.child_id
        where a.assigned_by=$1 and ch.parent_id <> $2`, [uids.rose, uids.seth])).rows[0].n
    cross === 0 ? ok('no Rose write attached to a child outside Seth\'s family') : bad(`${cross} cross-family Rose writes`)
  } finally { await c.end() }
} finally {
  await browser.close()
  server.kill()
}
console.log(fails ? `\n=== B5 E2E: ${fails} FAIL ===` : '\n=== B5 E2E: ALL PASS (UI is per-family scoped) ===')
process.exit(fails ? 1 : 0)
