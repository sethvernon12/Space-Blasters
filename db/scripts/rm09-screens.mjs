// ============================================================================
// RM-09 screenshots — the three role cockpits in the re-grounded Veritas-light
// skin (game-aligned navy/gold/cyan/mint/rose + Academy crest). Seeds real data
// + a pending grade + a pending assignment so the parent cockpit's approvals
// instrument shows. LOCAL only. Screenshots at iPad 390x844 + desktop 1440x900.
//
// Prereq: build the hub first — `npm --prefix hub run build`.
// Run: eval "$(supabase status -o env)"; node db/scripts/rm09-screens.mjs
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
const PORT = 8128
const uuid = () => crypto.randomUUID()
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const CID = { Brielle: FAMILY.alpha.children.brielle.childId }
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built'); process.exit(1) }

const cfg = m3Config()
console.log('Seeding data + a pending grade + a pending assignment…')
await setupFamily(cfg)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
const rose = await signInAs(cfg, FAMILY.alpha.tutor.email)
const brielle = await signInAs(cfg, FAMILY.alpha.children.brielle.email)
{
  const ses = uuid()
  await brielle.client.rpc('record_attempts_authed', { p_child_id: CID.Brielle, p_batch: buildBatch(Array.from({ length: 8 }, (_, i) => ({ clientAttemptId: uuid(), clientSessionId: ses, stageIndex: 0, skill: 'addition', result: i === 5 ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: i, level: 1, mode: 'journey', context: {} }))) })
  const sub = (await brielle.client.rpc('record_submission', { p_child_id: CID.Brielle, p_skill_id: 'add5', p_client_submission_id: uuid(), p_problem_dna: { operator: '+', operands: [2, 3], correct_answer: 5 }, p_submitted_answer: 5, p_explanation: 'I added them' })).data?.submission_id
  await rose.client.rpc('propose_grade', { p_submission_id: sub, p_verdict: 'correct', p_score: 100, p_feedback: 'Correct — nice work on Add within 5! You answered 5. Keep it up.', p_model: 'deterministic-v1', p_prompt_version: 'grade-v1', p_misconception_id: null })
  const plan = (await rose.client.rpc('pick_assignment_plan', { p_child_id: CID.Brielle })).data
  const items = (plan.items ?? []).map((it) => ({ ...it, prompt: `Blast it: what is ${it.operands[0]} + ${it.operands[1]}? 🚀` }))
  await rose.client.rpc('propose_assignment', { p_child_id: CID.Brielle, p_skill_id: plan.skill_id, p_difficulty: plan.difficulty, p_predicted_p: plan.predicted_p, p_items: items, p_title: 'Practice: Add within 5', p_model: 'deterministic-v1', p_prompt_version: 'assign-v1' })
  ok('seeded mastery + pending grade + pending assignment')
}

const fnServe = spawn('supabase', ['functions', 'serve'], { cwd: root, stdio: 'ignore', env: process.env })
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); try { const { data } = await seth.client.functions.invoke('child-summary', { body: { childId: CID.Brielle } }); if (data?.summary) ready = true } catch { /* boot */ } }
ready ? ok('functions serving (parent AI summary)') : bad('functions not ready')
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch({ args: ['--disable-web-security'] })

async function shot(role, ready_text, key) {
  for (const [label, w, h] of [['390', 390, 844], ['1440', 1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800 })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/`)
    if (key === 'signin') { await page.getByText('choose who', { exact: false }).first().waitFor({ timeout: 8000 }) }
    else {
      await page.getByRole('button', { name: role }).click()
      await page.getByText(ready_text, { exact: false }).first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(900)
    }
    await page.screenshot({ path: `${shots}/rm09-${key}-${label}.png`, fullPage: true })
    errs.length ? bad(`${key} ${label}: ${errs.join(';')}`) : ok(`rm09-${key}-${label} captured`)
    await ctx.close()
  }
}

try {
  await shot(null, null, 'signin')
  await shot(/^Seth/, 'Your children', 'parent')
  await shot(/^Brielle/, 'Hi, Brielle', 'child')
  await shot(/Grandma Rose/, 'Students you help', 'tutor')
} finally {
  await browser.close(); server.kill(); fnServe.kill()
}
console.log(fails ? `\nRM-09 SCREENS: ${fails} FAIL` : '\nRM-09 SCREENS: all captured')
process.exit(fails ? 1 : 0)
