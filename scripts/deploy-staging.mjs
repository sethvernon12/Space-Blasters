// ============================================================================
// deploy-staging.mjs — GUARDED CLI deploy to the academy-staging Vercel project
// ONLY. Hard-refuses ever targeting the space-blasters (production) project.
// Nothing runs without an explicit staging project id that is NOT the prod id.
// Env vars (anon key, passphrase) live in the academy-staging PROJECT (set in the
// Vercel dashboard) — Vercel builds with them; none are baked here.
//
//   VERCEL_TOKEN                team-scoped token (revoke after staging is up)
//   VERCEL_STAGING_PROJECT_ID   academy-staging Project ID  (Settings → Project ID)
//   SPACE_BLASTERS_PROJECT_ID   the prod project id — hard-DENY target
//
// Run (founder-gated): node scripts/deploy-staging.mjs
// ============================================================================
import { execFileSync } from 'node:child_process'

const ORG = 'team_DudfZQiLatUvrynySPaGMOZw' // Structorion LLC
const NAME = 'academy-staging'
const token = process.env.VERCEL_TOKEN
const stagingId = process.env.VERCEL_STAGING_PROJECT_ID
const denyId = process.env.SPACE_BLASTERS_PROJECT_ID

// ---- preflight guard (deterministic; refuses before any network call) ----
if (!token) throw new Error('Set VERCEL_TOKEN (team-scoped, revocable).')
if (!stagingId) throw new Error('Set VERCEL_STAGING_PROJECT_ID (the academy-staging Project ID).')
if (!denyId) throw new Error('Set SPACE_BLASTERS_PROJECT_ID so the guard can hard-deny the prod project.')
if (stagingId === denyId) throw new Error('REFUSING: staging id equals the space-blasters (prod) project id.')

const vercel = (args, opts = {}) => execFileSync('vercel', [...args, '--token', token, '--scope', ORG], { encoding: 'utf8', ...opts })

// resolve the target project and assert name + id (belt-and-suspenders over the id pin)
let resolved
try { resolved = JSON.parse(vercel(['project', 'inspect', stagingId, '--json'])) } catch { resolved = null }
if (resolved) {
  const id = resolved.id ?? resolved.projectId
  const name = resolved.name
  if (id && id === denyId) throw new Error('REFUSING: resolved target is the space-blasters project.')
  if (name && name !== NAME) throw new Error(`REFUSING: resolved project name "${name}" !== "${NAME}".`)
  if (id && id !== stagingId) throw new Error(`REFUSING: resolved id "${id}" !== VERCEL_STAGING_PROJECT_ID.`)
}
console.log(`preflight OK → deploying to ${NAME} (${stagingId}); space-blasters (${denyId}) is denied.`)

// deploy pinned to academy-staging via env (no .vercel linkage; cloud build uses
// the project's own env vars). --yes avoids any interactive project-linking prompt.
execFileSync('vercel', ['deploy', '--yes', '--prod', '--token', token, '--scope', ORG], {
  stdio: 'inherit',
  env: { ...process.env, VERCEL_ORG_ID: ORG, VERCEL_PROJECT_ID: stagingId },
})
console.log(`deployed to ${NAME}. (Remember to revoke VERCEL_TOKEN.)`)
