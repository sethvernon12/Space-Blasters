// ============================================================================
// verify-flag-off.mjs — build-time GUARD against the truthy-string trap and a
// tree-shaking regression on VITE_ALLOW_DEV_SIGNIN.
//
// The flag is read as a STRICT `=== 'true'` (session.tsx). A naive truthiness
// check (`if (env.X)`) would treat the STRING "false" as ON — leaking the dev
// switcher + synthetic-account creds into the real Google build. This guard
// builds under controlled inputs (any local hub/.env.local moved aside so the
// shell env is the only source) and asserts:
//   * flag "false"  -> OFF  (dev-switcher strings ABSENT, Google front door present)
//   * flag "true"   -> ON   (dev-switcher strings PRESENT)  [sanity: not always-off]
// Also directly falsifies "the .env.local override caused the local warning":
//   * flag unset (env.local aside) -> OFF (clean).
//
// Run: node scripts/verify-flag-off.mjs
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envLocal = path.join(root, 'hub', '.env.local')
const aside = envLocal + '.guard-bak'
const distAssets = path.join(root, 'dist', 'assets')

let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

function buildWith(flag) {
  const env = { ...process.env }
  if (flag === undefined) delete env.VITE_ALLOW_DEV_SIGNIN
  else env.VITE_ALLOW_DEV_SIGNIN = flag
  execFileSync('npm', ['--prefix', 'hub', 'run', 'build'], { cwd: root, env, stdio: 'ignore' })
}
function distHas(needle) {
  return readdirSync(distAssets).filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(path.join(distAssets, f), 'utf8').includes(needle))
}
const devSwitcherOn = () => distHas('@local.test') || distHas('localtest123')
const googleFrontDoor = () => distHas('with Google')

const movedAside = existsSync(envLocal)
if (movedAside) renameSync(envLocal, aside) // control inputs: shell env is the only source
try {
  console.log('build: flag UNSET (default, .env.local aside) …')
  buildWith(undefined)
  !devSwitcherOn() && googleFrontDoor() ? ok('flag unset -> OFF (dev switcher tree-shaken; Google front door)') : bad('flag unset did NOT build clean-OFF')

  console.log('build: flag="false" (truthy-string trap) …')
  buildWith('false')
  !devSwitcherOn() && googleFrontDoor() ? ok('flag "false" -> OFF (strict === \'true\'; no truthy trap)') : bad('flag "false" leaked the dev switcher (truthy trap!)')

  console.log('build: flag="true" (ON sanity) …')
  buildWith('true')
  devSwitcherOn() ? ok('flag "true" -> ON (dev switcher present)') : bad('flag "true" did NOT enable the dev switcher')
} finally {
  if (movedAside) renameSync(aside, envLocal) // always restore
  // leave dist in the developer's normal state (respects the restored .env.local)
  try { execFileSync('npm', ['--prefix', 'hub', 'run', 'build'], { cwd: root, stdio: 'ignore' }) } catch { /* best-effort */ }
}
console.log(fails ? `\n=== VERIFY-FLAG-OFF: ${fails} FAIL ===` : '\n=== VERIFY-FLAG-OFF: PASS (no truthy trap; tree-shaking holds) ===')
process.exit(fails ? 1 : 0)
