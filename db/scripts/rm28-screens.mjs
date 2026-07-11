// AR-4 visual capture — Academy acceptance-key redemption in the lobby → the
// enrolled parent lands in their cockpit. Keys are one-time, so a FRESH key is
// minted per viewport. Run (stack up, dist flag-on):
//   eval "$(supabase status -o env)"; node db/scripts/rm28-screens.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, adminClient, PASSWORD } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dist = path.join(root, 'dist')
const outDir = path.join(root, 'tools', 'screens'); fs.mkdirSync(outDir, { recursive: true })
const PORT = 8166
const NEWCOMER = 'newcomer@local.test'
const cfg = m3Config()
await setupFamily(cfg)
const admin = adminClient(cfg)
const mkUser = async (email) => {
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const ex = list.users.find((u) => u.email === email); if (ex) await admin.auth.admin.deleteUser(ex.id)
  return (await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })).data.user.id
}
const adminUid = await mkUser('academyadmin@local.test')
const adminC = await signInAs(cfg, 'academyadmin@local.test')
const { data: acad } = await adminC.client.from('groups').insert({ purpose: 'academy', name: 'Test Academy', created_by: adminUid }).select('id').single()
const ACADEMY = acad.id
const recreateNewcomer = async () => {
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const ex = list.users.find((u) => u.email === NEWCOMER); if (ex) await admin.auth.admin.deleteUser(ex.id)
  await admin.auth.admin.createUser({ email: NEWCOMER, password: PASSWORD, email_confirm: true })
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dist], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const browser = await chromium.launch()
const shots = [{ name: 'desktop', w: 1440, h: 900 }, { name: 'iphone', w: 390, h: 844 }]
const shot = (page, n) => page.screenshot({ path: path.join(outDir, `ar4-${n}.png`), fullPage: true })

try {
  for (const v of shots) {
    try {
      await recreateNewcomer()
      const { data: key } = await adminC.client.rpc('mint_invitation', { p_academy_id: ACADEMY, p_kind: 'enrolled_parent' })
      const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.getByRole('button', { name: /^Alex/ }).click()
      await page.getByTestId('lobby-academy-open').click()
      await page.getByTestId('lobby-academy-key').fill(key.code)
      await shot(page, `${v.name}-academy-key`)                 // key entered, Academy-controlled note
      await page.getByTestId('lobby-academy-continue').click()
      await page.getByText('Your children', { exact: false }).first().waitFor({ timeout: 15000 })
      await shot(page, `${v.name}-academy-parent`)              // enrolled → cockpit
      await ctx.close()
    } catch (e) { console.error(`  ${v.name} capture failed:`, e.message) }
  }
  console.log('screens →', outDir)
} finally {
  await browser.close(); server.kill()
}
