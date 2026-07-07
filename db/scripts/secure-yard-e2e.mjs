// ============================================================================
// Secure-yard e2e — serves the child-summary Edge Function locally and drives
// the FULL spine: authorize -> pack -> gateway(mock) -> verify -> moderate ->
// audit. Asserts allow/deny + no-name + audit rows, then screenshots the parent
// view (with the AI summary card) at iPad 390x844 + desktop 1440x900. LOCAL only;
// the gateway uses the caller's JWT (no service-role key).
//
// Prereq: build the hub first — `npm --prefix hub run build`.
// Run: eval "$(supabase status -o env)"; node db/scripts/secure-yard-e2e.mjs
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
const PORT = 8125
const uuid = () => crypto.randomUUID()
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const CID = { Brielle: FAMILY.alpha.children.brielle.childId }
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ not built — run `npm --prefix hub run build`'); process.exit(1) }

const cfg = m3Config()
console.log('Seed + Brielle records a real 7/8 set…')
const uids = await setupFamily(cfg)
const seth = await signInAs(cfg, FAMILY.alpha.parent.email)
const dana = await signInAs(cfg, FAMILY.beta.parent.email)
const brielle = await signInAs(cfg, FAMILY.alpha.children.brielle.email)
{
  const ses = uuid()
  await brielle.client.rpc('record_attempts_authed', {
    p_child_id: CID.Brielle,
    p_batch: buildBatch(Array.from({ length: 8 }, (_, i) => ({ clientAttemptId: uuid(), clientSessionId: ses, stageIndex: 0, skill: 'addition', result: i === 5 ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: i === 5 ? 4 : 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: i, level: 1, mode: 'journey', context: { source: 'sy' } }))),
  })
}

console.log('Starting `supabase functions serve`…')
const fnServe = spawn('supabase', ['functions', 'serve', '--no-verify-jwt=false'], { cwd: root, stdio: 'ignore', env: process.env })
// poll readiness by invoking as Seth until a structured summary comes back
let ready = false
for (let i = 0; i < 45 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  try {
    const { data } = await seth.client.functions.invoke('child-summary', { body: { childId: CID.Brielle } })
    if (data?.summary) ready = true
  } catch { /* not up yet */ }
}
ready ? ok('edge function is serving') : bad('edge function never became ready')

try {
  if (ready) {
    // ---- EDGE spine assertions ----
    console.log('Edge gateway spine:')
    {
      const { data } = await seth.client.functions.invoke('child-summary', { body: { childId: CID.Brielle } })
      const s = data?.summary ?? ''
      s.includes('80%') && s.includes('Add within 5') ? ok(`Seth (parent) gets a real-data summary: "${s.slice(0, 70)}…"`) : bad(`summary not real: ${s.slice(0, 120)}`)
      !s.includes('Brielle') ? ok('summary contains NO name (pack had none)') : bad('NAME LEAK in summary')
      data?.meta?.provider === 'mock' ? ok(`served by the fail-closed mock provider (model ${data.meta.model})`) : bad(`provider wrong: ${JSON.stringify(data?.meta)}`)
    }
    {
      const { data, error } = await dana.client.functions.invoke('child-summary', { body: { childId: CID.Brielle } })
      ;(error || data?.denied) ? ok('Dana (other family) → denied (403), no summary') : bad(`cross-family should be denied: ${JSON.stringify(data)}`)
    }
    // ---- audit rows written ----
    console.log('Audit:')
    {
      const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
      try {
        const allow = (await c.query(`select detail from public.audit_log where child_id=$1 and actor_id=$2 and decision='allow' and action='child.summary.read'`, [CID.Brielle, uids.seth])).rows
        allow.length >= 1 && allow[0].detail.prompt_version === 'summary-v1' ? ok(`allow audit row for Seth (provider=${allow[0].detail.provider}, prompt=${allow[0].detail.prompt_version})`) : bad(`missing/incomplete allow audit: ${JSON.stringify(allow)}`)
        const deny = (await c.query(`select decision from public.audit_log where child_id=$1 and actor_id=$2 and decision='deny'`, [CID.Brielle, uids.dana])).rows
        deny.length >= 1 ? ok('deny audit row for Dana (the denied attempt was logged)') : bad('no deny audit row for Dana')
      } finally { await c.end() }
    }
  }

  // ---- HUB screenshots: parent view shows the summary card ----
  console.log('Hub parent view (summary card):')
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
      await page.getByRole('button', { name: /^Seth/ }).click()
      await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 10000 })
      await page.locator('[data-testid="ai-summary"]').first().waitFor({ timeout: 12000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${shots}/hub-parent-summary-${label}.png`, fullPage: true })
      errs.length ? bad(`parent ${label}: page errors: ${errs.join(';')}`) : ok(`parent ${label}: summary card rendered, no errors`)
      await ctx.close()
    }
  } finally {
    await browser.close()
    server.kill()
  }
} finally {
  fnServe.kill()
}
console.log(fails ? `\n=== SECURE-YARD E2E: ${fails} FAIL ===` : '\n=== SECURE-YARD E2E: ALL PASS ===')
process.exit(fails ? 1 : 0)
