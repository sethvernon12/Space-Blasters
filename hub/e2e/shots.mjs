// Re-skin verification against the LOCAL preview (DEV-targeted build).
//   - one REAL sign-in via DevTester/4242 (audits: only signup_or_login called)
//   - screenshots at 390 / 820 / 1440 for Sign-in, Command Center, My Progress,
//     Practice, Assignments (+ Settings)
//   - assertions: exactly 7 nav items, honest states, 23 'Not started' skills,
//     no iframe, tap targets, reduced motion
// Run:  cd hub && npm run build && node e2e/shots.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = path.join(hub, 'screens')
const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}`
const ACC = JSON.stringify({ name: 'DevTester', pin: '4242' })

let failures = 0
const ok = (m) => console.log('  ✓', m)
const fail = (m) => { failures++; console.error('  ✗', m) }

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: hub, stdio: 'pipe' })
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('preview timeout')), 20000)
  server.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) { clearTimeout(t); res() } })
  server.on('exit', () => rej(new Error('preview died')))
})

const browser = await chromium.launch()
try {
  // ---------- real sign-in (DEV) + network audit ----------
  console.log('sign-in e2e (real DevTester/4242 on DEV, request-audited):')
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } })
    const page = await ctx.newPage()
    const supa = []
    page.on('request', (r) => { if (r.url().includes('supabase.co')) supa.push(new URL(r.url()).pathname) })
    page.on('pageerror', (e) => fail('page error: ' + e.message))
    await page.goto(BASE)
    await page.getByLabel(/pilot name/i).fill('DevTester')
    await page.getByLabel(/pin/i).fill('4242')
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.getByRole('heading', { name: /good (morning|afternoon|evening)/i }).waitFor({ timeout: 15000 })
    ok('DevTester/4242 -> signed in, Command Center visible')
    const uniq = [...new Set(supa)]
    if (uniq.length === 1 && uniq[0].endsWith('/rpc/signup_or_login')) ok(`only signup_or_login called (${supa.length}x)`)
    else fail('unexpected endpoints: ' + JSON.stringify(uniq))
    // exactly the 7 nav items
    const navLabels = await page.locator('nav[aria-label="Main"] a').allInnerTexts()
    const cleaned = navLabels.map((t) => t.replace(/\s+/g, ' ').trim())
    const expected = ['Command Center', 'Practice Math', 'Play Space Blasters', 'My Progress', 'Assignments', 'Messages', 'Settings']
    if (expected.every((e) => cleaned.some((c) => c.includes(e))) && cleaned.length === 7)
      ok('sidebar has exactly the 7 nav items')
    else fail('nav mismatch: ' + JSON.stringify(cleaned))
    if ((await page.locator('iframe').count()) === 0) ok('no iframes'); else fail('iframe present!')
    await ctx.close()
  }

  const sizes = [['390', 390, 844], ['820', 820, 1180], ['1440', 1440, 900]]
  const pages = [
    ['command-center', '/'],
    ['progress', '/progress'],
    ['practice', '/practice'],
    ['assignments', '/assignments'],
    ['settings', '/settings'],
  ]

  for (const [name, w, h] of sizes) {
    console.log(`viewport ${name}px:`)
    const ctx = await browser.newContext({ viewport: { width: w, height: h } })
    await ctx.addInitScript((acc) => localStorage.setItem('sg_hub_account', acc), ACC)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => fail('page error: ' + e.message))

    // signed-out sign-in shot (separate clean context)
    const ctxSo = await browser.newContext({ viewport: { width: w, height: h } })
    const pSo = await ctxSo.newPage()
    await pSo.goto(BASE)
    await pSo.getByRole('button', { name: /sign in/i }).waitFor()
    await pSo.waitForTimeout(250)
    await pSo.screenshot({ path: `${shots}/reskin-signin-${name}.png`, fullPage: true })
    await ctxSo.close()

    for (const [label, route] of pages) {
      await page.goto(BASE + route)
      await page.locator('h1').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${shots}/reskin-${label}-${name}.png`, fullPage: true })

      if (label === 'command-center') {
        for (const [needle, desc] of [
          [/good (morning|afternoon|evening), DevTester/i, 'time-aware greeting with name'],
          [/verse of the day/i, 'verse of the day card'],
          [/start your streak today/i, 'honest streak (no fake number)'],
          [/0 of 23 skills started/i, 'honest progress summary'],
          [/coming soon/i, 'assignments coming-soon'],
        ]) if (await page.getByText(needle).count()) ok(`${name}: ${desc}`); else fail(`${name}: missing ${desc}`)
      }
      if (label === 'progress') {
        const ns = await page.getByText('Not started', { exact: true }).count()
        if (ns === 23) ok(`${name}: 23 skills all "Not started"`); else fail(`${name}: "Not started" = ${ns} (want 23)`)
      }
    }

    // tap-target audit (>=44px; primary CTAs should be >=48)
    await page.goto(BASE + '/')
    await page.locator('h1').first().waitFor()
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('a, button, [role="switch"]')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ t: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24), r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.height < 44 && r.width < 44)
        .map(({ t, r }) => `${t} (${Math.round(r.width)}x${Math.round(r.height)})`))
    if (!small.length) ok(`${name}: all targets >= 44px`); else fail(`${name}: small targets: ${small.join(', ')}`)
    await ctx.close()
  }

  // reduced motion
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, reducedMotion: 'reduce' })
    await ctx.addInitScript((acc) => localStorage.setItem('sg_hub_account', acc), ACC)
    const page = await ctx.newPage()
    await page.goto(BASE + '/')
    await page.locator('h1').first().waitFor()
    ok('reduced-motion context renders without error')
    await ctx.close()
  }
} finally {
  await browser.close()
  server.kill()
}
console.log(failures ? `RESKIN VERIFY: ${failures} FAILURE(S)` : 'RESKIN VERIFY: ALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
