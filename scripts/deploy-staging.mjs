// ============================================================================
// deploy-staging.mjs — GUARDED, non-interactive setup + deploy of the
// academy-staging Vercel project. Creates the project, sets its env vars,
// attaches the domain, and deploys — and runs the IDENTICAL deny-guard before
// EVERY mutating step: proceed only if the resolved project name === academy-
// staging AND its id !== the space-blasters (prod) project id. Fails CLOSED: if
// the target can't be resolved+verified, nothing mutating runs.
//
// Reads (from the shell env; nothing secret is committed):
//   VERCEL_TOKEN               team-scoped token (revoke after staging is up)
//   SPACE_BLASTERS_PROJECT_ID  prod project id — hard-DENY (re-verified below)
//   DEV_SUPABASE_URL           → project env VITE_SUPABASE_URL
//   DEV_SUPABASE_ANON_KEY      → project env VITE_SUPABASE_PUBLISHABLE_KEY (legacy anon JWT)
//   VITE_STAGING_GATE          → project env VITE_STAGING_GATE (access passphrase)
//
// Run (founder-gated): node scripts/deploy-staging.mjs
// ============================================================================
import { execFileSync } from 'node:child_process'

const ORG = 'team_DudfZQiLatUvrynySPaGMOZw' // Structorion LLC
const NAME = 'academy-staging'
const DOMAIN = 'theallaroundathleteacademy.com'
const ENVIRONMENT = 'production' // academy-staging's own "production" = the staging site

const token = process.env.VERCEL_TOKEN
const denyId = process.env.SPACE_BLASTERS_PROJECT_ID
const supaUrl = process.env.DEV_SUPABASE_URL
const supaAnon = process.env.DEV_SUPABASE_ANON_KEY
const gate = process.env.VITE_STAGING_GATE

// ---- required inputs (refuse before any network call) ----
for (const [k, v] of [['VERCEL_TOKEN', token], ['SPACE_BLASTERS_PROJECT_ID', denyId],
  ['DEV_SUPABASE_URL', supaUrl], ['DEV_SUPABASE_ANON_KEY', supaAnon], ['VITE_STAGING_GATE', gate]]) {
  if (!v) throw new Error(`Set ${k} before running.`)
}

const vercel = (args, opts = {}) => execFileSync('vercel', [...args, '--token', token, '--scope', ORG], { encoding: 'utf8', ...opts })
const tryJson = (s) => { try { return JSON.parse(s) } catch { return null } }

// Resolve academy-staging from Vercel's project list (name → id). Returns the
// project object or null. Never trusts a caller-supplied id.
function resolveStaging() {
  const out = tryJson(vercel(['project', 'ls', '--json'])) // array of projects (best-effort across CLI versions)
  const list = Array.isArray(out) ? out : Array.isArray(out?.projects) ? out.projects : null
  if (!list) return null
  return list.find((p) => p?.name === NAME) ?? null
}

// The deny-guard — run before EVERY mutating step. Fails CLOSED.
function assertStagingTarget() {
  const p = resolveStaging()
  const id = p?.id ?? p?.projectId
  if (!p || !id) throw new Error(`REFUSING: could not resolve project "${NAME}" (fail-closed).`)
  if (p.name !== NAME) throw new Error(`REFUSING: resolved name "${p.name}" !== "${NAME}".`)
  if (id === denyId) throw new Error('REFUSING: target id equals the space-blasters (prod) project.')
  return id
}

// ---- 0. re-verify the deny target really is space-blasters (own confirmation) ----
{
  const all = tryJson(vercel(['project', 'ls', '--json']))
  const list = Array.isArray(all) ? all : all?.projects ?? []
  const denyProj = list.find((p) => (p?.id ?? p?.projectId) === denyId)
  if (denyProj && denyProj.name !== 'space-blasters') {
    throw new Error(`REFUSING: SPACE_BLASTERS_PROJECT_ID resolves to "${denyProj.name}", not "space-blasters".`)
  }
  console.log(`deny target confirmed: ${denyId}${denyProj ? ` (${denyProj.name})` : ''}`)
}

// ---- 1. create academy-staging (idempotent) ----
if (!resolveStaging()) {
  console.log(`creating project ${NAME}…`)
  vercel(['project', 'add', NAME])
} else {
  console.log(`project ${NAME} already exists — reusing.`)
}
const stagingId = assertStagingTarget()
console.log(`✓ target locked: ${NAME} (${stagingId}); ${denyId} denied.`)
const pin = { ...process.env, VERCEL_ORG_ID: ORG, VERCEL_PROJECT_ID: stagingId }

// ---- 2. set the three project env vars (guard before each) ----
function setEnv(name, value) {
  assertStagingTarget()
  // remove any prior value, then add (value on stdin — never on argv/logs)
  try { vercel(['env', 'rm', name, ENVIRONMENT, '--yes'], { env: pin }) } catch { /* none yet */ }
  vercel(['env', 'add', name, ENVIRONMENT], { input: value, env: pin })
  console.log(`  env set: ${name}`)
}
setEnv('VITE_SUPABASE_URL', supaUrl)
setEnv('VITE_SUPABASE_PUBLISHABLE_KEY', supaAnon)
setEnv('VITE_STAGING_GATE', gate)
setEnv('VITE_ALLOW_DEV_SIGNIN', 'true') // synthetic staging keeps the dev switcher; a real-families build must NOT set this

// ---- 3. attach the domain (guard) ----
assertStagingTarget()
try { vercel(['domains', 'add', DOMAIN, NAME], { env: pin }); console.log(`  domain attached: ${DOMAIN}`) }
catch (e) { console.log(`  domain step: ${String(e.message).split('\n')[0]} (may already be attached — verify in dashboard)`) }

// ---- 4. deploy (guard) pinned to academy-staging via env ----
assertStagingTarget()
console.log(`deploying ${NAME}…`)
execFileSync('vercel', ['deploy', '--yes', '--prod', '--token', token, '--scope', ORG], { stdio: 'inherit', env: pin })
console.log(`✓ deployed to ${NAME}. Next: bind ${DOMAIN} in the dashboard if not auto-assigned, then run dev-verify + browser smoke. (Revoke VERCEL_TOKEN when done.)`)
