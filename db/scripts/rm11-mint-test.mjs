// ============================================================================
// RM-11 mint self-test — Phase 3 Slice 2. Serves the REAL create-child +
// start-child-session Edge Functions and adversarially attacks the mint:
// no-email child creation, DB-isolated minted session, cross-family mint,
// non-parent mint, child-caller escalation, link leakage, single-use/replay,
// rate-limit. LOCAL only. Run (stack up): node db/scripts/rm11-mint-test.mjs
// ============================================================================
import pgpkg from 'pg'
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'

const { Client } = pgpkg
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
const A = FAMILY.alpha
const CID = { Brielle: A.children.brielle.childId }
const db = new Client({ connectionString: cfg.dbUrl })
const q = (s, p = []) => db.query(s, p)

console.log('Setup + serve functions…')
const uids = await setupFamily(cfg)
await db.connect()
const S = {}
for (const [w, e] of [['seth', A.parent.email], ['rose', A.tutor.email], ['dana', FAMILY.beta.parent.email]]) S[w] = await signInAs(cfg, e)
S.brielle = await mintChildSession(cfg, S.seth.client, CID.Brielle)

const fnServe = spawn('supabase', ['functions', 'serve'], { cwd: cfg.root || '/Users/myphone/space-blasters', stdio: 'ignore', env: process.env })
const invoke = async (fn, token, bodyObj) => {
  const res = await fetch(`${cfg.apiUrl}/functions/v1/${fn}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj),
  })
  let j = null; try { j = await res.json() } catch { /* */ }
  return { status: res.status, body: j }
}
// wait for readiness
let ready = false
for (let i = 0; i < 40 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke('create-child', S.seth.session.access_token, {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('functions serving') : bad('functions not ready')

try {
  // ---- 1. create-child: a NO-EMAIL child under the parent ----
  console.log('create-child (no-email child under parent):')
  const cc = await invoke('create-child', S.seth.session.access_token, { nickname: 'Newkid', gradeBand: '2' })
  const newId = cc.body?.child_id
  const row = newId ? (await q(`select c.parent_id, c.nickname, u.email from public.children c join auth.users u on u.id = c.auth_user_id where c.id=$1`, [newId])).rows[0] : null
  cc.status === 200 && row && row.parent_id === uids.seth && row.nickname === 'Newkid' && /@child\.invalid$/.test(row.email)
    ? ok('created a no-email child (opaque @child.invalid handle) bound under Seth') : bad(`create-child: ${JSON.stringify({ cc, row })}`)

  // ---- 2. start-child-session: minted session is the child + DB-isolated ----
  console.log('start-child-session (minted, isolated, no link leak):')
  const mint = await invoke('start-child-session', S.seth.session.access_token, { childId: newId })
  const leakKeys = mint.body ? Object.keys(mint.body).filter((k) => /hashed_token|action_link|otp|token_hash|verify/i.test(k)) : ['no-body']
  const noLeak = mint.status === 200 && !!mint.body?.access_token && leakKeys.length === 0
  noLeak ? ok('mint returns a session, and NO raw link/otp/token_hash in the response') : bad(`link-leak: keys=${JSON.stringify(mint.body && Object.keys(mint.body))}`)
  if (mint.body?.access_token) {
    // Newkid has NO consent yet → the data-before-consent gate (AC7) means even a
    // valid minted session sees nothing until consent is recorded (Phase 3.5).
    const childClient = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    await childClient.auth.setSession({ access_token: mint.body.access_token, refresh_token: mint.body.refresh_token })
    const newkidSelf = (await childClient.from('children').select('id').eq('id', newId)).data?.length ?? 0
    newkidSelf === 0 ? ok('a minted NO-CONSENT child sees nothing (data-before-consent gate holds under a mint)') : bad(`no-consent child saw ${newkidSelf}`)
  }
  // a CONSENTED minted child (Brielle) is DB-isolated: sees own profile, not a sibling
  const bSelf = (await S.brielle.client.from('children').select('id').eq('id', CID.Brielle)).data?.length ?? 0
  const bSibling = (await S.brielle.client.from('children').select('id').eq('id', A.children.theo.childId)).data?.length ?? 0
  bSelf === 1 && bSibling === 0 ? ok('a consented minted child sees only its own profile, never a sibling (DB-isolated)') : bad(`minted isolation: self=${bSelf} sibling=${bSibling}`)

  // ---- 3. cross-family mint denied ----
  console.log('attacks:')
  const xfam = await invoke('start-child-session', S.dana.session.access_token, { childId: newId })
  xfam.status === 403 && xfam.body?.reason === 'not_authorized' ? ok('cross-family mint denied (Dana cannot mint Seth\'s child)') : bad(`cross-family: ${JSON.stringify(xfam)}`)

  // ---- 4. non-parent (tutor) mint denied — mint requires the PARENT ----
  const tut = await invoke('start-child-session', S.rose.session.access_token, { childId: CID.Brielle })
  tut.status === 403 && tut.body?.reason === 'not_authorized' ? ok('granted tutor cannot mint (ownership = parent only)') : bad(`tutor mint: ${JSON.stringify(tut)}`)

  // ---- 5. child-caller escalation denied ----
  const childCreate = await invoke('create-child', S.brielle.session.access_token, { nickname: 'X' })
  const childMint = await invoke('start-child-session', S.brielle.session.access_token, { childId: newId })
  const childRpc = (await S.brielle.client.rpc('authorize_and_record_mint', { p_child_id: newId })).data
  childCreate.status === 403 && childMint.status === 403 && childRpc?.error === 'not_authorized'
    ? ok('a minted CHILD session cannot create children, mint sessions, or self-authorize a mint') : bad(`child escalation: ${JSON.stringify({ childCreate, childMint, childRpc })}`)

  // ---- 5b. register_child is service-only: a client can't bind an arbitrary adult uid ----
  const forge = await S.rose.client.rpc('register_child', { p_parent_id: uids.rose, p_auth_user_id: uids.seth, p_nickname: 'x', p_grade_band: null })
  const sethPoisoned = (await q(`select count(*)::int n from public.children where auth_user_id=$1`, [uids.seth])).rows[0].n
  const forgeBlocked = (!!forge.error || !forge.data?.ok) && sethPoisoned === 0
  forgeBlocked ? ok('register_child is service-only — a client cannot bind an arbitrary adult uid (no takeover / no is_child_actor poisoning)') : bad(`register_child forge: ${JSON.stringify({ forge, sethPoisoned })}`)

  // ---- 6. single-use / replay: a one-time link cannot be verified twice ----
  const admin = createClient(cfg.apiUrl, cfg.serviceKey, { auth: { persistSession: false } })
  const { data: u2 } = await admin.auth.admin.getUserById((await q(`select auth_user_id from public.children where id=$1`, [newId])).rows[0].auth_user_id)
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u2.user.email })
  const ex = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false } })
  const first = await ex.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  const ex2 = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false } })
  const second = await ex2.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  first.data?.session && !second.data?.session ? ok('a one-time link is single-use (replay of the same token fails)') : bad(`replay: first=${!!first.data?.session} second=${!!second.data?.session}`)

  // ---- 7. rate-limit: >10 mints/parent/60s is refused (do this LAST) ----
  let limited = 0
  for (let i = 0; i < 12; i++) { const r = await invoke('start-child-session', S.seth.session.access_token, { childId: newId }); if (r.body?.reason === 'rate_limited') limited++ }
  limited >= 1 ? ok(`mint rate-limit engaged (${limited} refused within the window)`) : bad('rate-limit never engaged')
} finally {
  fnServe.kill()
  await db.end()
}
console.log(fails ? `\n=== RM-11 MINT: ${fails} FAIL ===` : '\n=== RM-11 MINT: ALL PASS (mint attacks repelled) ===')
process.exit(fails ? 1 : 0)
