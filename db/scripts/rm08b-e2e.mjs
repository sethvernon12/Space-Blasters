// ============================================================================
// RM-08b e2e — the generate-assignment gateway (SQL plan -> mock wording ->
// verify -> moderate -> propose -> audit) end to end, then the tutor "Pending
// AI assignments" card screenshots at 390x844 + 1440x900. LOCAL only.
//
// Prereq: build the hub first — `npm --prefix hub run build`.
// Run: eval "$(supabase status -o env)"; node db/scripts/rm08b-e2e.mjs
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
const shots = path.join(root, 'hub', 'screens')
fs.mkdirSync(shots, { recursive: true })
const PORT = 8127
const uuid = () => crypto.randomUUID()
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const CID = { Brielle: FAMILY.alpha.children.brielle.childId }
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built — run `npm --prefix hub run build`'); process.exit(1) }

const cfg = m3Config()
console.log('Seed + Brielle has mastery…')
await setupFamily(cfg)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
const rose = await signInAs(cfg, FAMILY.alpha.tutor.email)
const dana = await signInAs(cfg, FAMILY.beta.parent.email)
const brielle = await signInAs(cfg, FAMILY.alpha.children.brielle.email)
{
  const ses = uuid()
  await brielle.client.rpc('record_attempts_authed', { p_child_id: CID.Brielle, p_batch: buildBatch(Array.from({ length: 8 }, (_, i) => ({ clientAttemptId: uuid(), clientSessionId: ses, stageIndex: 0, skill: 'addition', result: i === 5 ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: i, level: 1, mode: 'journey', context: {} }))) })
}

console.log('Starting `supabase functions serve`…')
const fnServe = spawn('supabase', ['functions', 'serve'], { cwd: root, stdio: 'ignore', env: process.env })
let ready = false
for (let i = 0; i < 45 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  try { const { data } = await seth.client.functions.invoke('child-summary', { body: { childId: CID.Brielle } }); if (data?.summary) ready = true } catch { /* booting */ }
}
ready ? ok('edge functions serving') : bad('functions never became ready')

try {
  if (ready) {
    console.log('generate-assignment gateway (proposal only):')
    {
      const { data } = await rose.client.functions.invoke('generate-assignment', { body: { childId: CID.Brielle } })
      data?.proposal_id && (data.prompts ?? []).length === 4 ? ok(`AI drafted ${data.prompts.length} items for ${data.skill} (~${Math.round(data.predicted_p * 100)}% target): "${data.prompts[0]}"`) : bad(`generate: ${JSON.stringify(data)}`)
      !(data?.prompts ?? []).some((p) => /Brielle/.test(p)) ? ok('rendered prompts carry NO child name') : bad('NAME LEAK in prompts')
      const pend = (await rose.client.rpc('pending_assignments')).data ?? []
      pend.length >= 1 ? ok(`proposal in the tutor approvals queue (${pend.length})`) : bad('proposal not in queue')
    }
    {
      const { data, error } = await dana.client.functions.invoke('generate-assignment', { body: { childId: CID.Brielle } })
      ;(error || data?.denied) ? ok('other family → generate-assignment denied') : bad(`cross-family generate: ${JSON.stringify(data)}`)
    }
    {
      const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
      try {
        const a = (await c.query(`select count(*)::int n from public.audit_log where action='ai.assignment.propose' and child_id=$1 and decision='allow'`, [CID.Brielle])).rows[0].n
        const delivered = (await c.query(`select count(*)::int n from public.assignments where child_id=$1 and items is not null`, [CID.Brielle])).rows[0].n
        a >= 1 && delivered === 0 ? ok('audit written; NOTHING delivered until human approval (ACC-05)') : bad(`audit/deliver: audit=${a} delivered=${delivered}`)
      } finally { await c.end() }
    }
  }

  // ---- Hub: the tutor "Pending AI assignments" card + Deliver ----
  console.log('Hub tutor assignments card:')
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 800))
  const browser = await chromium.launch({ args: ['--disable-web-security'] })
  try {
    for (const [label, w, h] of [['390', 390, 844], ['1440', 1440, 900]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800 })
      const page = await ctx.newPage()
      const errs = []
      page.on('pageerror', (e) => errs.push(e.message))
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /Grandma Rose/ }).click()
      await page.getByText('Students you help', { exact: false }).first().waitFor({ timeout: 10000 })
      await page.locator('[data-testid="pending-assignments"]').first().waitFor({ timeout: 12000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${shots}/hub-assign-approvals-${label}.png`, fullPage: true })
      if (label === '1440') {
        await page.getByRole('button', { name: /Deliver to student/ }).first().click()
        await page.getByText('Assignment delivered', { exact: false }).first().waitFor({ timeout: 8000 })
        ok('tutor Deliver → assignment delivered (human-in-the-loop)')
      }
      errs.length ? bad(`${label}: page errors: ${errs.join(';')}`) : ok(`assignments card rendered at ${label}, no errors`)
      await ctx.close()
    }
  } finally { await browser.close(); server.kill() }
} finally { fnServe.kill() }
console.log(fails ? `\n=== RM-08b E2E: ${fails} FAIL ===` : '\n=== RM-08b E2E: ALL PASS ===')
process.exit(fails ? 1 : 0)
