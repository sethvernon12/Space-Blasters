// ============================================================================
// redeploy-staging.mjs — GUARDED, minimal REDEPLOY of the existing academy-staging
// Vercel project (no env/domain mutation). For pushing a new build (e.g. B1) to
// the staging site once the project + env are already set up by deploy-staging.mjs.
//
// Uses the repo-PINNED Vercel CLI (node_modules/.bin/vercel) — fail-fast if absent,
// never an npx fallback that could silently fetch a different version. Runs the
// IDENTICAL deny-guard before every network step: proceed only if the resolved
// project name === academy-staging AND its id !== the space-blasters (prod) id.
// Also VERIFIES the project build config is safe before deploying:
//   * VITE_ALLOW_DEV_SIGNIN is NOT enabled (flag-OFF = the real Google front door)
//   * VITE_SUPABASE_URL points at the DEV project (never prod)
//   * VITE_STAGING_GATE is set (access gate on)
// Deploys a PREVIEW first (throwaway validation of the pinned CLI + build), then
// the founder-facing --prod deploy that promotes to the staging domain.
//
// Reads (shell env; nothing secret committed):
//   VERCEL_TOKEN               team-scoped, short-lived (revoke after)
//   SPACE_BLASTERS_PROJECT_ID  prod project id — hard-DENY (re-verified)
// Run: node scripts/redeploy-staging.mjs
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORG = 'team_DudfZQiLatUvrynySPaGMOZw' // Structorion LLC
const NAME = 'academy-staging'
const DEV_REF = 'appplvbgyghlhrjcaagn'
const PROD_REF = 'oafovcrxdjoyaxsytyjg'
const ENVIRONMENT = 'production' // academy-staging's own "production" = the staging site

const token = process.env.VERCEL_TOKEN
const denyId = process.env.SPACE_BLASTERS_PROJECT_ID
for (const [k, v] of [['VERCEL_TOKEN', token], ['SPACE_BLASTERS_PROJECT_ID', denyId]]) {
  if (!v) throw new Error(`Set ${k} before running.`)
}

// Repo-pinned CLI only — fail fast (no npx auto-fetch of a different version).
const BIN = path.join(root, 'node_modules', '.bin', 'vercel')
if (!existsSync(BIN)) throw new Error('Pinned Vercel CLI missing. Run `npm ci --ignore-scripts` (it is a devDependency).')
const env = { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' }
const vercel = (args, opts = {}) => execFileSync(BIN, [...args, '--token', token, '--scope', ORG], { encoding: 'utf8', env, ...opts })
const tryJson = (s) => { try { return JSON.parse(s) } catch { return null } }

function resolveStaging() {
  const out = tryJson(vercel(['project', 'ls', '--json']))
  const list = Array.isArray(out) ? out : Array.isArray(out?.projects) ? out.projects : null
  return list ? (list.find((p) => p?.name === NAME) ?? null) : null
}
function assertStagingTarget() {
  const p = resolveStaging()
  const id = p?.id ?? p?.projectId
  if (!p || !id) throw new Error(`REFUSING: could not resolve "${NAME}" (fail-closed).`)
  if (p.name !== NAME) throw new Error(`REFUSING: resolved name "${p.name}" !== "${NAME}".`)
  if (id === denyId) throw new Error('REFUSING: target id equals the space-blasters (prod) project.')
  return id
}

// 0. re-verify the deny target really is space-blasters
{
  const all = tryJson(vercel(['project', 'ls', '--json']))
  const list = Array.isArray(all) ? all : all?.projects ?? []
  const denyProj = list.find((p) => (p?.id ?? p?.projectId) === denyId)
  if (denyProj && denyProj.name !== 'space-blasters') {
    throw new Error(`REFUSING: SPACE_BLASTERS_PROJECT_ID resolves to "${denyProj.name}", not "space-blasters".`)
  }
  console.log(`deny target confirmed: ${denyId}${denyProj ? ` (${denyProj.name})` : ''}`)
}

const stagingId = assertStagingTarget()
console.log(`✓ target locked: ${NAME} (${stagingId}); ${denyId} denied.`)
const pin = { ...env, VERCEL_ORG_ID: ORG, VERCEL_PROJECT_ID: stagingId }

// 1. VERIFY the build config is safe (flag-OFF Google build, DEV-targeted, gated)
const checkFile = path.join(root, '.env.staging-verify')
try {
  assertStagingTarget()
  vercel(['env', 'pull', checkFile, `--environment=${ENVIRONMENT}`], { env: pin })
  const envText = readFileSync(checkFile, 'utf8')
  const get = (k) => (envText.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').replace(/^"|"$/g, '')
  const devSignin = get('VITE_ALLOW_DEV_SIGNIN')
  const supaUrl = get('VITE_SUPABASE_URL')
  const gate = get('VITE_STAGING_GATE')
  if (devSignin === 'true') throw new Error('REFUSING: VITE_ALLOW_DEV_SIGNIN=true — the dev switcher must be OFF for the Google front door.')
  if (supaUrl.includes(PROD_REF)) throw new Error('REFUSING: VITE_SUPABASE_URL points at PROD.')
  if (!supaUrl.includes(DEV_REF)) throw new Error(`REFUSING: VITE_SUPABASE_URL does not target DEV (${DEV_REF}).`)
  if (!gate) throw new Error('REFUSING: VITE_STAGING_GATE is not set — the access gate would be off.')
  console.log(`✓ build config: dev-switcher OFF, Supabase → DEV (${DEV_REF}), access gate ON.`)
} finally {
  rmSync(checkFile, { force: true }) // never leave pulled env values on disk
}

// 2. throwaway PREVIEW deploy (validates the pinned CLI + the build before founder-facing)
assertStagingTarget()
console.log('preview deploy (throwaway validation)…')
const previewUrl = vercel(['deploy', '--yes'], { env: pin }).trim().split('\n').pop()
console.log(`✓ preview built + deployed: ${previewUrl}`)

// 3. founder-facing PROD deploy → promotes to the staging domain
assertStagingTarget()
console.log('prod deploy (promotes to the staging domain)…')
execFileSync(BIN, ['deploy', '--yes', '--prod', '--token', token, '--scope', ORG], { stdio: 'inherit', env: pin })
console.log(`✓ deployed to ${NAME} (--prod). Verify the staging URL, then revoke VERCEL_TOKEN.`)
