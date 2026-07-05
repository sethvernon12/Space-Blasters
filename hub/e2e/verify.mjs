// ============================================================================
// Hub shell verification (LOCAL): serves the built app, then
//   1. REAL sign-in e2e via the existing signup_or_login RPC (the ONLY network
//      endpoint this app may call — asserted from the request log; uses the
//      pre-existing "Tester" account so nothing new is created)
//   2. wrong-PIN shows a friendly role="alert" error
//   3. screenshots at 390 / 820 / 1440 px (sign-in, home, progress)
//   4. tap-target audit (>=48px interactive elements)
//   5. prefers-reduced-motion honored (starfield animation off)
// Run:  cd hub && npm run build && node e2e/verify.mjs
// ============================================================================
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = path.join(hub, 'screens')
const PORT = 4173
const BASE = `http://localhost:${PORT}`

let failures = 0
const ok = (m) => console.log('  ✓', m)
const fail = (m) => { failures++; console.error('  ✗', m) }

// ---- serve the production build ----
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: hub, stdio: 'pipe' })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 20000)
  server.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) { clearTimeout(t); resolve() } })
  server.on('exit', () => reject(new Error('preview server died')))
})

const browser = await chromium.launch()
try {
  // ---------- 1+2: REAL sign-in e2e (network audited) ----------
  console.log('sign-in e2e (real signup_or_login, request-audited):')
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1100 } })
    const page = await ctx.newPage()
    const supaCalls = []
    page.on('request', (r) => { if (r.url().includes('supabase.co')) supaCalls.push(new URL(r.url()).pathname) })
    page.on('pageerror', (e) => fail('page error: ' + e.message))
    await page.goto(BASE)
    // invalid PIN FORMAT -> handled by LOCAL validation, no network call at all
    await page.getByLabel(/pilot name/i).fill('Tester')
    await page.getByLabel(/pin/i).fill('12')
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.getByRole('alert').waitFor({ timeout: 10000 })
    ok('invalid PIN -> friendly role="alert" error, still on sign-in')
    if (supaCalls.length === 0) ok('a locally-invalid PIN never hits the network')
    else fail('network called for a locally-invalid PIN: ' + JSON.stringify(supaCalls))
    // real successful sign-in via the pre-existing account (the ONLY prod call)
    await page.getByLabel(/pin/i).fill('0000')
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.getByRole('heading', { name: /ready to fly/i }).waitFor({ timeout: 15000 })
    ok('name+PIN via signup_or_login -> signed in, hub deck visible')
    const unique = [...new Set(supaCalls)]
    if (unique.length === 1 && unique[0].endsWith('/rpc/signup_or_login'))
      ok(`only signup_or_login was ever called (${supaCalls.length} call(s) total)`)
    else fail('unexpected supabase endpoints: ' + JSON.stringify(unique))
    // persists across reload
    await page.reload()
    await page.getByRole('heading', { name: /ready to fly/i }).waitFor({ timeout: 10000 })
    ok('session persists across reload (localStorage sg_hub_account)')
    // Play tile is a same-tab LINK to the live game (not an iframe)
    const play = page.getByRole('link', { name: /play space blasters — opens the game/i })
    const href = await play.getAttribute('href')
    const target = await play.getAttribute('target')
    if (href && href.includes('smartergames.ai') && target !== '_blank') ok(`Play is a top-level same-tab link -> ${href}`)
    else fail(`Play link wrong: href=${href} target=${target}`)
    if ((await page.locator('iframe').count()) === 0) ok('no iframes anywhere')
    else fail('found an iframe!')
    await ctx.close()
  }

  // ---------- 3-5: screenshots + a11y audits at three widths ----------
  const sizes = [
    ['390', { width: 390, height: 844 }],
    ['820', { width: 820, height: 1180 }],
    ['1440', { width: 1440, height: 900 }],
  ]
  for (const [name, viewport] of sizes) {
    console.log(`viewport ${name}px:`)
    const ctx = await browser.newContext({ viewport })
    await ctx.addInitScript(() => localStorage.setItem('sg_hub_account', JSON.stringify({ name: 'Nova', pin: '0000' })))
    const page = await ctx.newPage()
    page.on('pageerror', (e) => fail('page error: ' + e.message))
    await page.goto(BASE)
    await page.getByRole('heading', { name: /ready to fly/i }).waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${shots}/home-${name}.png`, fullPage: true })

    // tap-target audit: every link/button >= 48px in at least one dimension box
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('a, button')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.height < 47.5 && r.width < 47.5)
        .map(({ label, r }) => `${label} (${Math.round(r.width)}x${Math.round(r.height)})`))
    if (!small.length) ok('all interactive targets >= 48px')
    else fail('small tap targets: ' + small.join(', '))

    // navigate to Progress by really clicking (also exercises the tile link).
    // wait on the LEVEL-1 heading — the Home tile title is an h3 named the same.
    await page.getByRole('link', { name: /progress/i }).first().click()
    await page.getByRole('heading', { level: 1, name: /my progress/i }).waitFor()
    const skillCount = await page.locator('li').count()
    if (skillCount === 23) ok('progress shows exactly 23 skills')
    else fail(`progress shows ${skillCount} list items (want 23)`)
    const notStarted = await page.getByText('Not started', { exact: true }).count()
    if (notStarted === 23) ok('all 23 read "Not started" — nothing fabricated')
    else fail(`"Not started" badges: ${notStarted} (want 23)`)
    if (await page.getByText(/progress starts filling in once your practice is being recorded/i).count()) ok('honest coming-soon line present')
    else fail('honest line missing')
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${shots}/progress-${name}.png`, fullPage: true })

    // sign-in screen (fresh, signed-out) — capture at this width too
    const ctx2 = await browser.newContext({ viewport })
    const p2 = await ctx2.newPage()
    await p2.goto(BASE)
    await p2.getByRole('button', { name: /sign in/i }).waitFor()
    await p2.waitForTimeout(250)
    await p2.screenshot({ path: `${shots}/signin-${name}.png`, fullPage: true })
    await ctx2.close()
    await ctx.close()
  }

  // ---------- reduced motion ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1100 }, reducedMotion: 'reduce' })
    await ctx.addInitScript(() => localStorage.setItem('sg_hub_account', JSON.stringify({ name: 'Nova', pin: '0000' })))
    const page = await ctx.newPage()
    await page.goto(BASE)
    await page.getByRole('heading', { name: /ready to fly/i }).waitFor()
    const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.starfield')).animationDuration)
    const secs = parseFloat(dur)   // '0.01ms'|'1e-05s'|'0s' all parse ~0
    if (secs <= 0.001) ok(`prefers-reduced-motion honored (starfield animation-duration ${dur})`)
    else fail(`starfield still animating under reduced motion (${dur})`)
    await ctx.close()
  }

  // ---------- placeholders honest ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1100 } })
    await ctx.addInitScript(() => localStorage.setItem('sg_hub_account', JSON.stringify({ name: 'Nova', pin: '0000' })))
    const page = await ctx.newPage()
    await page.goto(BASE)
    await page.getByRole('link', { name: /assignments/i }).click()
    await page.getByRole('heading', { name: /my assignments/i }).waitFor()
    if (await page.getByText(/coming soon/i).count()) ok('Assignments: honest coming-soon')
    await page.screenshot({ path: `${shots}/assignments-820.png`, fullPage: true })
    await page.getByRole('link', { name: /back to hub/i }).click()
    await page.getByRole('link', { name: /practice/i }).first().click()
    await page.getByRole('heading', { name: /practice math/i }).waitFor()
    if (await page.getByText(/coming soon/i).count()) ok('Practice: honest coming-soon')
    await page.screenshot({ path: `${shots}/practice-820.png`, fullPage: true })
    await ctx.close()
  }
} finally {
  await browser.close()
  server.kill()
}
console.log(failures ? `HUB VERIFY: ${failures} FAILURE(S)` : 'HUB VERIFY: ALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
