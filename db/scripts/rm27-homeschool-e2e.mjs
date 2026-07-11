// AR-3 homeschool self-serve onboarding — arena-tagged family + starter template
// + CROSS-FAMILY ISOLATION (the gating test). LOCAL only.
//   * create_homeschool_family: self-serve standalone family (purpose=family,
//     arena=homeschool), idempotent, guardian membership, child-actor refused.
//   * apply_starter_template: grade-appropriate ASSIGNMENTS (never mastery),
//     owner-only, consent-gated, idempotent.
//   * ISOLATION: family A ≠ family B — no cross-family group/child/template reach.
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm27-homeschool-e2e.mjs
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, adminClient, FAMILY, PASSWORD } from './family.mjs'

const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const BRIELLE = A.children.brielle.childId // grade '1', alpha
const WREN = B.children.wren.childId       // beta
const NEWCOMER = 'newcomer@local.test'
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

console.log('Setup (applies 0001–0022) + a brand-new adult…')
await setupFamily(cfg)
const admin = adminClient(cfg)
{ const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const ex = list.users.find((u) => u.email === NEWCOMER)
  if (ex) await admin.auth.admin.deleteUser(ex.id)
  await admin.auth.admin.createUser({ email: NEWCOMER, password: PASSWORD, email_confirm: true }) }
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)

const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const alex = await signInAs(cfg, NEWCOMER)
const brielleLogin = await signInAs(cfg, A.children.brielle.email) // a CHILD actor

try {
  // ---- create_homeschool_family: self-serve standalone family ----
  const { data: cf } = await alex.client.rpc('create_homeschool_family')
  cf?.ok && cf.group_id && cf.existing === false ? ok('newcomer creates a homeschool family') : bad(`create_homeschool_family: ${JSON.stringify(cf)}`)
  const gid = cf?.group_id
  const grp = (await q(`select purpose, arena, created_by from public.groups where id=$1`, [gid]))[0]
  ;(grp?.purpose === 'family' && grp.arena === 'homeschool' && grp.created_by === alex.uid)
    ? ok('family group is purpose=family, arena=homeschool, owned by the parent') : bad(`group shape: ${JSON.stringify(grp)}`)
  const mem = (await q(`select role, active, member_actor_id from public.memberships where group_id=$1`, [gid]))
  mem.length === 1 && mem[0].role === 'guardian' && mem[0].active && mem[0].member_actor_id === alex.uid
    ? ok('a guardian membership was created for the parent') : bad(`membership: ${JSON.stringify(mem)}`)

  // my_family reflects it (router basis)
  const { data: mf } = await alex.client.rpc('my_family')
  ;(Array.isArray(mf) && mf[0]?.group_id === gid && mf[0]?.arena === 'homeschool') ? ok('my_family() returns the homeschool family (router → parent)') : bad(`my_family: ${JSON.stringify(mf)}`)

  // idempotent
  const { data: cf2 } = await alex.client.rpc('create_homeschool_family')
  cf2?.ok && cf2.existing === true && cf2.group_id === gid ? ok('create_homeschool_family is idempotent') : bad(`idempotency: ${JSON.stringify(cf2)}`)

  // a CHILD actor can never create a family
  const { data: cfChild } = await brielleLogin.client.rpc('create_homeschool_family')
  cfChild?.ok === false && cfChild.error === 'not_authorized' ? ok('a child actor is refused (not_authorized)') : bad(`child create: ${JSON.stringify(cfChild)}`)

  // ---- starter template: grade-appropriate assignments, NEVER mastery ----
  const { data: st } = await seth.client.rpc('apply_starter_template', { p_child_id: BRIELLE })
  st?.ok && st.created === 3 && st.existing === false ? ok('starter template created 3 grade-1 to-dos for Brielle') : bad(`starter: ${JSON.stringify(st)}`)
  const asg = await q(`select a.title, a.status, s.grade_band from public.assignments a join public.skills s on s.id=a.skill_id where a.child_id=$1 order by s.position`, [BRIELLE])
  asg.length === 3 && asg.every((r) => r.status === 'assigned' && r.title.startsWith('Starter: ')) ? ok('assignments are titled "Starter: …", status assigned') : bad(`assignments: ${JSON.stringify(asg)}`)
  asg.every((r) => r.grade_band === '1') ? ok('every starter skill is grade-1 (grade-appropriate)') : bad(`grades: ${asg.map((r) => r.grade_band)}`)
  const mastery = (await q(`select count(*)::int n from public.child_skill_mastery where child_id=$1`, [BRIELLE]))[0].n
  mastery === 0 ? ok('NO mastery fabricated (honest record — mastery only from real attempts)') : bad(`starter wrote ${mastery} mastery rows!`)

  // idempotent (never clobbers existing work)
  const { data: st2 } = await seth.client.rpc('apply_starter_template', { p_child_id: BRIELLE })
  st2?.ok && st2.created === 0 && st2.existing === true ? ok('starter template is idempotent') : bad(`starter idempotency: ${JSON.stringify(st2)}`)

  // ================= CROSS-FAMILY ISOLATION (the gate) =================
  // Dana (family B) cannot seed a starter plan for Brielle (family A's child)
  const { data: xTemplate } = await dana.client.rpc('apply_starter_template', { p_child_id: BRIELLE })
  xTemplate?.ok === false && xTemplate.error === 'not_found' ? ok('ISO: other-family parent cannot template my child (not_found)') : bad(`cross-template: ${JSON.stringify(xTemplate)}`)
  // and it did NOT create anything
  const stillThree = (await q(`select count(*)::int n from public.assignments where child_id=$1`, [BRIELLE]))[0].n === 3
  stillThree ? ok('ISO: Brielle still has exactly her 3 (nothing leaked in)') : bad('cross-family template mutated Brielle')

  // Dana cannot SEE Seth's family group (RLS)
  const { data: seenGroup } = await dana.client.from('groups').select('id').eq('id', gid)
  ;(seenGroup?.length ?? 0) === 0 ? ok('ISO: other-family parent cannot read my family group (RLS)') : bad('cross-family group leak')

  // Dana makes her OWN family — distinct, isolated, also arena=homeschool w/ no academy link
  const { data: cfD } = await dana.client.rpc('create_homeschool_family')
  const gidD = cfD?.group_id
  gidD && gidD !== gid ? ok('ISO: family B gets a DISTINCT family group') : bad('family B collided with A')
  const { data: sethSeesDana } = await seth.client.from('groups').select('id').eq('id', gidD)
  ;(sethSeesDana?.length ?? 0) === 0 ? ok('ISO: I cannot read the other family’s group either') : bad('reverse group leak')

  // arena isolation: homeschool family has NO academy link (org_id null, arena homeschool)
  const arenaRow = (await q(`select arena, org_id from public.groups where id=$1`, [gid]))[0]
  arenaRow.arena === 'homeschool' && arenaRow.org_id == null ? ok('ISO: homeschool family carries NO Academy link (org_id null)') : bad(`arena/org: ${JSON.stringify(arenaRow)}`)
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-27 HOMESCHOOL: ${fails} FAIL ===` : '\n=== RM-27 HOMESCHOOL: ALL PASS (arena-tagged family; grade starter to-dos; cross-family isolation) ===')
process.exit(fails ? 1 : 0)
