// AR-4 Academy acceptance-key redemption + invitation-led tutor/coach grants +
// SEC-REV-26 (sanction follows the stable Google sub). LOCAL only — the isolation
// gate. Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm28-academy-e2e.mjs
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY, PASSWORD } from './family.mjs'

const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId, THEO = A.children.theo.childId, WREN = B.children.wren.childId
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const mkUser = async (admin, email) => {
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const ex = list.users.find((u) => u.email === email); if (ex) await admin.auth.admin.deleteUser(ex.id)
  const { data } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true }); return data.user.id
}

console.log('Setup: families + academy admin + a tutor + a newcomer parent…')
await setupFamily(cfg)
const admin = adminClient(cfg)
const adminUid = await mkUser(admin, 'academyadmin@local.test')
const tutorUid = await mkUser(admin, 'coachtutor@local.test')
await mkUser(admin, 'newparent@local.test')
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)

const adminC = await signInAs(cfg, 'academyadmin@local.test')
const tutor = await signInAs(cfg, 'coachtutor@local.test')
const newp = await signInAs(cfg, 'newparent@local.test')
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const brielleLogin = await signInAs(cfg, A.children.brielle.email)

// the Academy admin creates the Academy group (Academy-controlled trust)
const { data: acad } = await adminC.client.from('groups').insert({ purpose: 'academy', name: 'Test Academy', created_by: adminUid }).select('id').single()
const ACADEMY = acad.id
const mint = (c, kind, target = null, canWrite = true) => c.rpc('mint_invitation', { p_academy_id: ACADEMY, p_kind: kind, p_target_child_id: target, p_can_write: canWrite })

try {
  // ---- mint authorization: ONLY the Academy's admin ----
  const { data: notAdmin } = await mint(dana.client, 'enrolled_parent')
  notAdmin?.ok === false && notAdmin.error === 'not_authorized' ? ok('non-admin cannot mint keys for the Academy') : bad(`mint authz: ${JSON.stringify(notAdmin)}`)

  // ---- enrolled_parent redemption ----
  const { data: epKey } = await mint(adminC.client, 'enrolled_parent')
  const { data: epRedeem } = await newp.client.rpc('redeem_invitation', { p_code: epKey.code })
  epRedeem?.ok && epRedeem.kind === 'enrolled_parent' ? ok('newcomer redeems an enrolled_parent key') : bad(`enrolled redeem: ${JSON.stringify(epRedeem)}`)
  const fam = (await q(`select arena, org_id, created_by from public.groups where created_by=$1 and purpose='family'`, [newp.uid]))[0]
  fam?.arena === 'academy' && fam.org_id === ACADEMY ? ok('an arena=academy family linked to the Academy was created') : bad(`academy family: ${JSON.stringify(fam)}`)
  const acMem = (await q(`select role from public.memberships where group_id=$1 and member_actor_id=$2`, [ACADEMY, newp.uid]))[0]
  acMem?.role === 'parent' ? ok('newcomer got an Academy parent membership') : bad(`academy membership: ${JSON.stringify(acMem)}`)
  const { data: mf } = await newp.client.rpc('my_family')
  mf?.[0]?.arena === 'academy' ? ok('my_family() → academy family (router → parent)') : bad(`my_family: ${JSON.stringify(mf)}`)
  // replay is one-time
  const { data: replay } = await newp.client.rpc('redeem_invitation', { p_code: epKey.code })
  replay?.ok === false && replay.error === 'invalid_or_used' ? ok('a redeemed key cannot be reused (one-time)') : bad(`replay: ${JSON.stringify(replay)}`)

  // enroll Seth so his child Brielle is Academy-enrolled (enrollment-is-consent)
  const { data: sethKey } = await mint(adminC.client, 'enrolled_parent')
  await seth.client.rpc('redeem_invitation', { p_code: sethKey.code })

  // ---- tutor redemption: SCOPED grant to EXACTLY the invited child ----
  const { data: tKey } = await mint(adminC.client, 'tutor', BRIELLE, true)
  const { data: tRedeem } = await tutor.client.rpc('redeem_invitation', { p_code: tKey.code })
  tRedeem?.ok && tRedeem.kind === 'tutor' ? ok('tutor redeems a scoped invitation for Brielle') : bad(`tutor redeem: ${JSON.stringify(tRedeem)}`)
  const grant = (await q(`select tutor_id, child_id, granted_by, can_write, active from public.tutor_grants where tutor_id=$1 and child_id=$2`, [tutorUid, BRIELLE]))[0]
  grant && grant.granted_by === seth.uid && grant.can_write === true && grant.active
    ? ok('grant is tutor→Brielle, granted_by=the enrolled parent, can_write, active') : bad(`grant: ${JSON.stringify(grant)}`)

  // SCOPE: the tutor sees ONLY Brielle — never Theo (same family) or Wren (family B)
  const { data: tutorKids } = await tutor.client.from('children').select('id')
  const ids = (tutorKids ?? []).map((r) => r.id)
  ids.length === 1 && ids[0] === BRIELLE ? ok('ISO: tutor sees ONLY Brielle (not Theo, not Wren)') : bad(`tutor sees: ${JSON.stringify(ids)}`)

  // TRANSPARENCY: the enrolled parent sees who has access to their child
  const { data: sethGrants } = await seth.client.from('tutor_grants').select('tutor_id,child_id')
  ;(sethGrants ?? []).some((g) => g.tutor_id === tutorUid && g.child_id === BRIELLE) ? ok('transparency: the parent sees the Academy-granted tutor on their child') : bad('parent cannot see the grant')

  // PARENT REVOCATION WINS: the parent removes the tutor; a later Academy re-mint
  // CANNOT silently re-grant (the parent holds revocation at any time — ratified model)
  await seth.client.from('tutor_grants').update({ active: false, revoked_at: new Date().toISOString() }).eq('tutor_id', tutorUid).eq('child_id', BRIELLE)
  const { data: reKey } = await mint(adminC.client, 'tutor', BRIELLE, true)
  const { data: reRedeem } = await tutor.client.rpc('redeem_invitation', { p_code: reKey.code })
  reRedeem?.ok === false && reRedeem.error === 'revoked_by_parent' ? ok('parent revocation WINS: an Academy re-mint cannot silently re-grant a revoked tutor') : bad(`re-grant: ${JSON.stringify(reRedeem)}`)
  const stillRevoked = (await q(`select active from public.tutor_grants where tutor_id=$1 and child_id=$2`, [tutorUid, BRIELLE]))[0]
  stillRevoked?.active === false ? ok('the parent-revoked grant stayed revoked') : bad(`grant reactivated: ${JSON.stringify(stillRevoked)}`)

  // ---- fail-closed ----
  const { data: bogus } = await tutor.client.rpc('redeem_invitation', { p_code: 'not-a-real-key-000000' })
  bogus?.ok === false && bogus.error === 'invalid_or_used' ? ok('an invalid key confers nothing (generic error)') : bad(`bogus: ${JSON.stringify(bogus)}`)
  // child actor can never redeem
  const { data: epKey2 } = await mint(adminC.client, 'enrolled_parent')
  const { data: childRedeem } = await brielleLogin.client.rpc('redeem_invitation', { p_code: epKey2.code })
  childRedeem?.ok === false && childRedeem.error === 'not_authorized' ? ok('a child actor cannot redeem (not_authorized)') : bad(`child redeem: ${JSON.stringify(childRedeem)}`)
  // expired key
  const { data: expKey } = await mint(adminC.client, 'enrolled_parent')
  const expHash = (await q(`select code_hash from public.invitations order by created_at desc limit 1`))[0].code_hash
  await q(`update public.invitations set expires_at = now() - interval '1 hour' where code_hash=$1`, [expHash])
  const { data: expRedeem } = await newp.client.rpc('redeem_invitation', { p_code: expKey.code })
  expRedeem?.ok === false && expRedeem.error === 'invalid_or_used' ? ok('an expired key confers nothing') : bad(`expired: ${JSON.stringify(expRedeem)}`)
  // tutor key for a NON-enrolled child (Wren, family B not enrolled) → refused
  const { data: wKey } = await mint(adminC.client, 'tutor', WREN, true)
  const { data: wRedeem } = await tutor.client.rpc('redeem_invitation', { p_code: wKey.code })
  wRedeem?.ok === false && wRedeem.error === 'child_not_enrolled' ? ok('ISO: cannot grant a tutor on a NON-enrolled child (child_not_enrolled)') : bad(`non-enrolled: ${JSON.stringify(wRedeem)}`)
  const wrenGrant = (await q(`select count(*)::int n from public.tutor_grants where child_id=$1`, [WREN]))[0].n
  wrenGrant === 0 ? ok('ISO: Wren (family B) got NO grant') : bad('cross-family grant leaked')

  // invitations RLS: a redeemer cannot enumerate keys; the admin sees its own
  const { data: tutorSeesInv } = await tutor.client.from('invitations').select('id')
  ;(tutorSeesInv?.length ?? 0) === 0 ? ok('ISO: a redeemer cannot read the invitations table') : bad('invitation enumeration leak')
  const { data: adminSeesInv } = await adminC.client.from('invitations').select('id')
  ;(adminSeesInv?.length ?? 0) > 0 ? ok('the Academy admin can see its own invitations') : bad('admin cannot see own invitations')

  // ================= SEC-REV-26: sanction follows the stable Google sub =================
  const xUid = await mkUser(admin, 'evader@local.test')
  const yUid = await mkUser(admin, 'evader-resignup@local.test')
  const SUB = 'google-sub-shared-xyz'
  await q(`insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
           values (gen_random_uuid(), $1, $2::text, 'google', jsonb_build_object('sub', $2::text), now(), now())`, [xUid, SUB])
  for (let i = 0; i < 5; i++) await q(`select public.record_family_flag($1, 'abuse', 0)`, [xUid])
  const xMuted = (await q(`select public.family_muted($1) m`, [xUid]))[0].m
  const sub = (await q(`select subject, standing from public.family_standing where subject=$1`, [SUB]))[0]
  xMuted && sub?.standing === 'suspended' ? ok('SEC-REV-26: standing is keyed to the Google sub (suspended)') : bad(`standing: muted=${xMuted} ${JSON.stringify(sub)}`)
  // simulate delete + re-signup: the SAME Google account now maps to a NEW uid (Y)
  await q(`update auth.identities set user_id=$1 where provider_id=$2 and provider='google'`, [yUid, SUB])
  const yMuted = (await q(`select public.family_muted($1) m`, [yUid]))[0].m
  const xMutedAfter = (await q(`select public.family_muted($1) m`, [xUid]))[0].m
  yMuted && !xMutedAfter ? ok('SEC-REV-26: re-signup (new uid, same sub) INHERITS the sanction — cannot shed it') : bad(`re-signup: yMuted=${yMuted} xMutedAfter=${xMutedAfter}`)
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-28 ACADEMY: ${fails} FAIL ===` : '\n=== RM-28 ACADEMY: ALL PASS (Academy-controlled keys; scoped tutor grants; fail-closed; SEC-REV-26 sub-anchored standing) ===')
process.exit(fails ? 1 : 0)
