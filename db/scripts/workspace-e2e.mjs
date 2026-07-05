// ============================================================================
// Workspace self-test — a fake child completes a practice set in the real
// workspace UI; each answer flows through the frozen contract -> recordAttempt
// on the LOCAL stack; we then prove the AttemptEvents landed PER-CHILD in the
// local DB (direct pg, test-side), and screenshot at iPad 390x844 + desktop
// 1440x900. LOCAL ONLY. Client uses anon key; readback is test-side pg.
//
// Run (stack up):  eval "$(supabase status -o env)"; node db/scripts/workspace-e2e.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import pgpkg from 'pg'
import { stackConfig, applySchema } from './local-stack.mjs'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.join(root, 'workspace', 'screens')
fs.mkdirSync(shots, { recursive: true })
const CHILD_ID = '0a0a0a0a-0000-4000-8000-00000000c0de'
const PORT = 8099
let failures = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { failures++; console.error('  ✗', m) }

const cfg = stackConfig()
await applySchema(cfg.dbUrl)                 // fresh schema + seeded consented child; resets rate limits
await new Promise((r) => setTimeout(r, 1200))

// static server for the repo root (module imports + workspace)
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', root], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))

const browser = await chromium.launch({ args: ['--disable-web-security'] })
const WS_CONFIG = { restUrl: cfg.restUrl, anonKey: cfg.anonKey, name: 'RoundTrip', pin: '2468', record: true, setSize: 5 }

async function runSet(label, w, h, { wrongAt = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800 })
  await ctx.addInitScript((c) => { window.__WS_CONFIG__ = c }, WS_CONFIG)
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/workspace/`)
  await page.waitForSelector('#choices .choice')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${shots}/workspace-practice-${label}.png`, fullPage: true })

  for (let i = 0; i < WS_CONFIG.setSize; i++) {
    await page.waitForFunction(() => {
      const p = document.getElementById('problem')
      return p && /\d\s*\+\s*\d/.test(p.textContent) &&
        [...document.querySelectorAll('.choice')].every((b) => !b.className.includes('right') && !b.className.includes('wrong'))
    }, { timeout: 8000 })
    const { text, answer } = await page.evaluate(() => {
      const t = document.getElementById('problem').textContent
      const [a, b] = t.split('+').map((x) => parseInt(x.trim(), 10))
      return { text: t, answer: a + b }
    })
    const target = (wrongAt === i)
      ? await page.evaluate((ans) => {                     // deliberately pick a wrong choice
          const w = [...document.querySelectorAll('.choice')].find((b) => Number(b.dataset.val) !== ans)
          return w ? w.dataset.val : null
        }, answer)
      : String(answer)
    await page.locator(`.choice[data-val="${target}"]`).first().click()
    await page.waitForTimeout(480)
  }

  await page.waitForFunction(() => window.__WS_RESULT__ != null, { timeout: 8000 })
  const result = await page.evaluate(() => window.__WS_RESULT__)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${shots}/workspace-readout-${label}.png`, fullPage: true })
  if (!errs.length) ok(`${label}: no page errors`); else bad(`${label}: page errors: ${errs.join('; ')}`)
  if (result.recorded === WS_CONFIG.setSize) ok(`${label}: UI recorded ${result.recorded} attempts (RPC inserted)`)
  else bad(`${label}: UI recorded ${result.recorded} (want ${WS_CONFIG.setSize})`)
  await ctx.close()
  return result
}

try {
  console.log('iPad 390x844 — fake child completes the set (all correct):')
  const r1 = await runSet('390', 390, 844)
  console.log('desktop 1440x900 — fake child completes the set (one wrong, to record an incorrect):')
  const r2 = await runSet('1440', 1440, 900, { wrongAt: 2 })

  // ---- DB EVIDENCE: the loop turned, per-child, in the local DB ----
  console.log('DB evidence (direct pg, test-side):')
  const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
  try {
    for (const [label, r] of [['390', r1], ['1440', r2]]) {
      const { rows } = await c.query(
        `select a.child_id, a.skill_id, a.result, a.context->>'source' as source, a.context->>'skillKey' as skill_key
           from public.attempts a join public.sessions s on s.id = a.session_id
          where s.client_session_id = $1 order by a.created_at`, [r.session])
      const allChild = rows.every((x) => x.child_id === CHILD_ID)
      const allAdd5 = rows.every((x) => x.skill_id === 'add5')
      const allWs = rows.every((x) => x.source === 'workspace' && x.skill_key === 'add5')
      const correct = rows.filter((x) => x.result === 'correct').length
      if (rows.length === 5 && allChild && allAdd5 && allWs)
        ok(`${label}: 5 attempts persisted on child ${CHILD_ID.slice(0, 8)}… (skill add5, source=workspace), ${correct} correct`)
      else bad(`${label}: rows=${rows.length} allChild=${allChild} allAdd5=${allAdd5} allWs=${allWs}`)
    }
    // per-child integrity: ALL workspace attempts belong to the one seeded child
    const { rows: distinct } = await c.query(
      `select count(distinct child_id)::int as kids, count(*)::int as n
         from public.attempts where context->>'source' = 'workspace'`)
    if (distinct[0].kids === 1 && distinct[0].n === 10)
      ok(`per-child: all ${distinct[0].n} workspace attempts on exactly 1 child`)
    else bad(`per-child: kids=${distinct[0].kids} n=${distinct[0].n} (want 1 / 10)`)
    // mastery projection moved for that child+skill (the flywheel turned server-side too)
    const { rows: m } = await c.query(
      `select attempts_count, correct_count, alpha, beta from public.child_skill_mastery
        where child_id = $1 and skill_id = 'add5'`, [CHILD_ID])
    if (m.length === 1 && m[0].attempts_count === 10)
      ok(`server mastery projection: add5 attempts_count=${m[0].attempts_count}, correct=${m[0].correct_count} (α=${m[0].alpha}, β=${m[0].beta})`)
    else bad(`server mastery projection wrong: ${JSON.stringify(m)}`)
  } finally { await c.end() }
} finally {
  await browser.close()
  server.kill()
}
console.log(failures ? `WORKSPACE E2E: ${failures} FAIL` : 'WORKSPACE E2E: ALL PASS')
process.exit(failures ? 1 : 0)
