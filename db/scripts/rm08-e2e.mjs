// ============================================================================
// RM-08 e2e — the grade-work gateway (solver -> mock -> verify -> moderate ->
// propose -> audit) end to end, then the tutor approvals-card screenshots at
// iPad 390x844 + desktop 1440x900. LOCAL only; caller-JWT only, mock provider.
//
// Prereq: build the hub first — `npm --prefix hub run build`.
// Run: eval "$(supabase status -o env)"; node db/scripts/rm08-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const shots = path.join(root, 'hub', 'screens')
fs.mkdirSync(shots, { recursive: true })
const PORT = 8126
const uuid = () => crypto.randomUUID()
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const CID = { Brielle: FAMILY.alpha.children.brielle.childId }
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built — run `npm --prefix hub run build`'); process.exit(1) }

const cfg = m3Config()
console.log('Seed + Brielle submits graded work…')
const uids = await setupFamily(cfg)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
const rose = await signInAs(cfg, FAMILY.alpha.tutor.email)
const dana = await signInAs(cfg, FAMILY.beta.parent.email)
const brielle = await signInAs(cfg, FAMILY.alpha.children.brielle.email)
const subId = (await brielle.client.rpc('record_submission', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: { operator: '+', operands: [2, 3], correct_answer: 5 }, p_submitted_answer: 5, p_explanation: 'I added 2 and 3' })).data?.submission_id
subId ? ok('Brielle submitted graded work') : bad('record_submission failed')

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
    console.log('grade-work gateway (proposal only):')
    {
      const { data } = await rose.client.functions.invoke('grade-work', { body: { submissionId: subId } })
      data?.proposal_id && data.verdict === 'correct' ? ok(`grade-work proposed a grade: verdict=${data.verdict}, "${(data.feedback || '').slice(0, 50)}…"`) : bad(`grade-work: ${JSON.stringify(data)}`)
      !/Brielle/.test(data?.feedback ?? '') ? ok('feedback carries NO child name') : bad('NAME LEAK in feedback')
      const pend = (await rose.client.rpc('pending_grades')).data ?? []
      pend.length >= 1 ? ok(`proposal appears in the tutor approvals queue (${pend.length})`) : bad('proposal not in queue')
    }
    {
      const { data, error } = await dana.client.functions.invoke('grade-work', { body: { submissionId: subId } })
      ;(error || data?.denied) ? ok('other family → grade-work denied (cannot even see the submission)') : bad(`cross-family grade-work: ${JSON.stringify(data)}`)
    }
    {
      const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
      try {
        const a = (await c.query(`select detail->>'model' m from public.audit_log where action='ai.grade.propose' and child_id=$1 and decision='allow'`, [CID.Brielle])).rows
        a.length >= 1 ? ok(`audit: ai.grade.propose allow row (model=${a[0].m})`) : bad('no grade-propose audit row')
        const rec = (await c.query(`select count(*)::int n from public.events where kind='grade' and subject_child_id=$1`, [CID.Brielle])).rows[0].n
        rec === 0 ? ok('nothing RECORDED yet (no grade Event) — awaits human approval (ACC-05)') : bad(`premature record: ${rec} grade events`)
      } finally { await c.end() }
    }
  }

  // ---- Hub: the tutor approvals card + Approve ----
  console.log('Hub tutor approvals card:')
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
      await page.locator('[data-testid="pending-grades"]').first().waitFor({ timeout: 12000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${shots}/hub-approvals-${label}.png`, fullPage: true })
      if (label === '1440') {
        await page.getByRole('button', { name: /^Approve$/ }).first().click()
        await page.getByText('Grade recorded', { exact: false }).first().waitFor({ timeout: 8000 })
        ok('tutor Approve → grade recorded (human-in-the-loop)')
      }
      errs.length ? bad(`${label}: page errors: ${errs.join(';')}`) : ok(`approvals card rendered at ${label}, no errors`)
      await ctx.close()
    }
  } finally { await browser.close(); server.kill() }
} finally { fnServe.kill() }
console.log(fails ? `\n=== RM-08 E2E: ${fails} FAIL ===` : '\n=== RM-08 E2E: ALL PASS ===')
process.exit(fails ? 1 : 0)
