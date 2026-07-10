// ============================================================================
// RM-24 step-up freshness (bug fix) — the delete-* step-up must key on the user's
// last_sign_in_at (which advances on a real Google OAuth re-auth), NOT the JWT amr
// timestamp (which does NOT advance on a Google re-auth → the reported infinite
// "Confirm it's you" loop). Simulates a real-Google-shaped session by driving
// last_sign_in_at directly (the token's amr stays FRESH throughout, so a pass proves
// the gate ignores amr):
//   * stale last_sign_in_at (>5m) → 401 reauth_required, ZERO destruction
//   * fresh last_sign_in_at (a re-auth advanced it) → the delete PROCEEDS (no loop)
//   for BOTH delete-account and delete-child.
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm24-stepup-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Wren: B.children.wren.childId }
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()

console.log('Setup + serve delete-account/delete-child…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const envFile = path.join(root, 'supabase', '.env.rm24'); fs.writeFileSync(envFile, '# rm24\n')
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const invoke = async (token, fn, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
const setSignIn = (uid, expr) => q(`update auth.users set last_sign_in_at = ${expr} where id = $1`, [uid])
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke(seth.session.access_token, 'delete-child', {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('functions not ready')

const kids = async (parent) => (await q(`select count(*)::int n from public.children where parent_id=$1`, [parent]))[0].n

try {
  // ---- delete-account: stale → reauth (no destruction), fresh → proceeds ----
  console.log('delete-account step-up:')
  await setSignIn(uids.dana, `now() - interval '10 minutes'`)   // stale session (amr in the token is still fresh)
  const daStale = await invoke(dana.session.access_token, 'delete-account', {})
  const danaIntact = await kids(uids.dana) === 1
  daStale.status === 401 && daStale.body?.error === 'reauth_required' && danaIntact
    ? ok('stale last_sign_in_at → 401 reauth_required, account NOT destroyed (amr freshness ignored)') : bad(`da stale: status=${daStale.status} body=${JSON.stringify(daStale.body)} intact=${danaIntact}`)

  await setSignIn(uids.dana, `now()`)                            // a re-auth advances last_sign_in_at
  const daFresh = await invoke(dana.session.access_token, 'delete-account', {})
  daFresh.status === 200 && daFresh.body?.ok && await kids(uids.dana) === 0
    ? ok('fresh last_sign_in_at → delete-account PROCEEDS (loop broken)') : bad(`da fresh: status=${daFresh.status} body=${JSON.stringify(daFresh.body)}`)

  // ---- delete-child: same gate ----
  console.log('delete-child step-up:')
  await setSignIn(uids.seth, `now() - interval '10 minutes'`)
  const dcStale = await invoke(seth.session.access_token, 'delete-child', { childId: CID.Brielle })
  const brielleIntact = (await q(`select count(*)::int n from public.children where id=$1`, [CID.Brielle]))[0].n === 1
  dcStale.status === 401 && dcStale.body?.error === 'reauth_required' && brielleIntact
    ? ok('stale → 401 reauth_required, child NOT destroyed') : bad(`dc stale: status=${dcStale.status} intact=${brielleIntact}`)

  await setSignIn(uids.seth, `now()`)
  const dcFresh = await invoke(seth.session.access_token, 'delete-child', { childId: CID.Brielle })
  dcFresh.status === 200 && dcFresh.body?.ok && (await q(`select count(*)::int n from public.children where id=$1`, [CID.Brielle]))[0].n === 0
    ? ok('fresh → delete-child PROCEEDS (loop broken)') : bad(`dc fresh: status=${dcFresh.status} body=${JSON.stringify(dcFresh.body)}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-24 STEP-UP: ${fails} FAIL ===` : '\n=== RM-24 STEP-UP: ALL PASS (last_sign_in_at gate; stale→reauth; fresh→proceeds, no loop) ===')
process.exit(fails ? 1 : 0)
