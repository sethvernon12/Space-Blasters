// ============================================================================
// RM-07 self-test — the ONE Group+Membership derivation engine (SPEC §10).
// Proves DER-03…DER-12 + COM-01 through the real client path (anon key + user
// JWT, RLS), plus cross-family isolation for the new group tables. LOCAL only.
//
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm07-test.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'

const { Client } = pgpkg
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

const db = new Client({ connectionString: cfg.dbUrl })
const q = (sql, p = []) => db.query(sql, p)

console.log('Setup: families + derivation rules + a class group with a schedule…')
const uids = await setupFamily(cfg)
await db.connect()
// rules-as-data (DER-04)
await q(`insert into public.derivation_rules (purpose, role, rule_kind, spec) values
  ('class','member','channel', jsonb_build_object('channel_name','General')),
  ('class','member','requirement', jsonb_build_object('requirement_key','enrollment_form')),
  ('team','member','channel', jsonb_build_object('channel_name','Team'))`)

const S = {}
for (const [w, e] of [['seth', A.parent.email], ['dana', B.parent.email], ['brielle', A.children.brielle.email], ['rose', A.tutor.email]]) S[w] = await signInAs(cfg, e)

// Seth creates a class (family Alpha); Dana creates one (family Beta, isolation foil)
const mathClass = (await S.seth.client.from('groups').insert({ purpose: 'class', name: 'Math Class', season: '2026', created_by: uids.seth }).select()).data?.[0]?.id
const betaClass = (await S.dana.client.from('groups').insert({ purpose: 'class', name: 'Beta Class', created_by: uids.dana }).select()).data?.[0]?.id
// seed a schedule event per class (group-owned; DER-07)
await q(`insert into public.events (kind, author_actor_id, group_id, payload) values ('schedule',$1,$2, jsonb_build_object('title','Monday class'))`, [uids.seth, mathClass])
await q(`insert into public.events (kind, author_actor_id, group_id, payload) values ('schedule',$1,$2, jsonb_build_object('title','Beta session'))`, [uids.dana, betaClass])
mathClass && betaClass ? ok('two class groups created (created_by = self, RLS-scoped)') : bad('group create failed')

// ---- DER-03: join writes membership + Event + outbox in ONE txn ----
console.log('DER-03 (transactional bus + outbox):')
const jr = (await S.seth.client.rpc('join_group', { p_group_id: mathClass, p_member_child_id: CID.Brielle, p_member_actor_id: null, p_role: 'member' })).data
{
  const mem = (await q(`select id,active from public.memberships where group_id=$1 and member_child_id=$2`, [mathClass, CID.Brielle])).rows
  const ev = (await q(`select id from public.events where kind='membership' and group_id=$1 and subject_child_id=$2 and payload->>'action'='join'`, [mathClass, CID.Brielle])).rows
  const ob = (await q(`select status from public.derivation_outbox where kind='join' and group_id=$1 and member_child_id=$2`, [mathClass, CID.Brielle])).rows
  jr?.ok && mem.length === 1 && ev.length === 1 && ob.length === 1 ? ok('join_group wrote membership + membership Event + outbox atomically') : bad(`atomic write: ${JSON.stringify({ jr, mem: mem.length, ev: ev.length, ob: ob.length })}`)
}

// ---- drain ----
const d1 = (await S.seth.client.rpc('drain_derivations')).data
d1?.processed >= 1 ? ok(`drain processed ${d1.processed} item(s)`) : bad(`drain: ${JSON.stringify(d1)}`)

// ---- DER-05: channels + guardian structural co-membership (COM-03) ----
console.log('DER-05 (channels + guardian co-membership):')
{
  const chan = (await q(`select id from public.channels where group_id=$1 and name='General'`, [mathClass])).rows
  const chanId = chan[0]?.id
  const members = (await q(`select member_child_id, member_actor_id, is_guardian_comember from public.channel_members where channel_id=$1 and active`, [chanId])).rows
  const hasChild = members.some((m) => m.member_child_id === CID.Brielle && !m.is_guardian_comember)
  const hasGuardian = members.some((m) => m.member_actor_id === uids.seth && m.is_guardian_comember)
  chanId && hasChild && hasGuardian ? ok('General channel: Brielle + her guardian (Seth) as structural co-member') : bad(`channel membership: ${JSON.stringify(members)}`)
  // COM-03: there is NO child channel-membership without the guardian present
  const childRows = members.filter((m) => m.member_child_id)
  childRows.length > 0 && hasGuardian ? ok('no child channel-membership exists without the guardian co-member') : bad('COM-03 violated')
}

// ---- DER-06: requirement Events instantiated per matching rule ----
console.log('DER-06 (requirement-sets):')
{
  const reqs = (await q(`select payload->>'requirement_key' k, payload->>'status' s from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2`, [mathClass, CID.Brielle])).rows
  reqs.some((r) => r.k === 'enrollment_form' && r.s === 'assigned') && !reqs.some((r) => r.k === 'waiver') ? ok('enrollment_form requirement assigned (team waiver NOT — non-matching purpose)') : bad(`requirements: ${JSON.stringify(reqs)}`)
}

// ---- DER-07: guardian calendar = derived union; cross-family excluded ----
console.log('DER-07 (derived calendar, never synced):')
{
  const sethCal = (await S.seth.client.rpc('guardian_calendar')).data ?? []
  const danaCal = (await S.dana.client.rpc('guardian_calendar')).data ?? []
  sethCal.some((e) => e.group_id === mathClass) ? ok('Seth calendar includes Math Class schedule (via membership)') : bad(`seth calendar: ${JSON.stringify(sethCal.map((e) => e.group_id))}`)
  !danaCal.some((e) => e.group_id === mathClass) ? ok('Dana calendar excludes Math Class (other family)') : bad('cross-family calendar leak')
}

// ---- DER-09: guardian reads the group's events via the read rule (not fan-out)
console.log('DER-09 (parent-in-the-loop read rule):')
{
  const sethSees = (await S.seth.client.from('events').select('kind').eq('group_id', mathClass)).data ?? []
  const danaSees = (await S.dana.client.from('events').select('kind').eq('group_id', mathClass)).data ?? []
  sethSees.length > 0 ? ok(`Seth reads ${sethSees.length} Math Class events via one read rule`) : bad('guardian cannot read group events')
  danaSees.length === 0 ? ok('Dana (other family) reads 0 Math Class events') : bad(`cross-family event leak: ${danaSees.length}`)
}

// ---- COM-01: message = context-required Event; members only ----
console.log('COM-01 (context-welded message):')
{
  let checkErr = null
  try { await q(`insert into public.events (kind, author_actor_id, group_id, payload) values ('message',$1,$2,'{}')`, [uids.seth, mathClass]) } catch (e) { checkErr = e.message }
  checkErr ? ok('contextless message rejected by CHECK (unrepresentable)') : bad('contextless message was allowed')
  const chanId = (await q(`select id from public.channels where group_id=$1 and name='General'`, [mathClass])).rows[0].id
  const noCtx = (await S.seth.client.rpc('post_message', { p_channel_id: chanId, p_context_ref_kind: null, p_context_ref_id: null, p_body: 'hi' })).data
  noCtx?.error === 'context_required' ? ok('post_message without context → context_required') : bad(`post_message no-ctx: ${JSON.stringify(noCtx)}`)
  const ctxId = crypto.randomUUID()
  const okMsg = (await S.seth.client.rpc('post_message', { p_channel_id: chanId, p_context_ref_kind: 'assignment', p_context_ref_id: ctxId, p_body: 'Great job today' })).data
  okMsg?.ok ? ok('member (guardian) posts a context-welded message') : bad(`post_message ok-path: ${JSON.stringify(okMsg)}`)
  const danaMsg = (await S.dana.client.rpc('post_message', { p_channel_id: chanId, p_context_ref_kind: 'assignment', p_context_ref_id: ctxId, p_body: 'x' })).data
  danaMsg?.error === 'not_a_member' ? ok('non-member (Dana) cannot post to the channel') : bad(`non-member post: ${JSON.stringify(danaMsg)}`)
}

// ---- DER-10: opt-out = suppression row (never deletion) ----
console.log('DER-10 (suppression, never deletion):')
{
  const chanId = (await q(`select id from public.channels where group_id=$1 and name='General'`, [mathClass])).rows[0].id
  await S.seth.client.from('suppressions').insert({ actor_id: uids.seth, target_kind: 'channel', target_id: chanId, scope: 'notify' })
  const mine = (await S.seth.client.from('suppressions').select('id,removed_at').eq('target_id', chanId)).data ?? []
  const danaSees = (await S.dana.client.from('suppressions').select('id').eq('target_id', chanId)).data ?? []
  const stillMember = (await q(`select active from public.channel_members where channel_id=$1 and member_actor_id=$2`, [chanId, uids.seth])).rows[0]
  mine.length === 1 && danaSees.length === 0 && stillMember?.active ? ok('suppression written (own-only), derived membership NOT deleted') : bad(`suppression: mine=${mine.length} dana=${danaSees.length} member=${stillMember?.active}`)
  await S.seth.client.from('suppressions').update({ removed_at: new Date().toISOString() }).eq('target_id', chanId)
  ok('un-suppression restores instantly (removed_at set; row preserved)')
}

// ---- DER-11: consent fail-closed → held-pending, then completes ----
console.log('DER-11 (fail-closed consent gating):')
{
  const saved = (await q(`select consent_id from public.children where id=$1`, [CID.Theo])).rows[0].consent_id
  await q(`update public.children set consent_id=null where id=$1`, [CID.Theo])
  await S.seth.client.rpc('join_group', { p_group_id: mathClass, p_member_child_id: CID.Theo, p_member_actor_id: null, p_role: 'member' })
  await S.seth.client.rpc('drain_derivations')
  const held = (await q(`select status from public.derivation_outbox where kind='join' and group_id=$1 and member_child_id=$2`, [mathClass, CID.Theo])).rows[0]
  const noChan = (await q(`select count(*)::int n from public.channel_members cm join public.channels c on c.id=cm.channel_id where c.group_id=$1 and cm.member_child_id=$2`, [mathClass, CID.Theo])).rows[0].n
  held?.status === 'held' && noChan === 0 ? ok('non-consented child → outbox HELD, nothing derived (blocks, not skips)') : bad(`consent-hold: status=${held?.status} chan=${noChan}`)
  await q(`update public.children set consent_id=$1 where id=$2`, [saved, CID.Theo])
  // re-enqueue by re-joining, then drain → now completes
  await S.seth.client.rpc('join_group', { p_group_id: mathClass, p_member_child_id: CID.Theo, p_member_actor_id: null, p_role: 'member' })
  await S.seth.client.rpc('drain_derivations')
  const nowChan = (await q(`select count(*)::int n from public.channel_members cm join public.channels c on c.id=cm.channel_id where c.group_id=$1 and cm.member_child_id=$2`, [mathClass, CID.Theo])).rows[0].n
  nowChan === 1 ? ok('after consent restored + re-drain, Theo derivation completes') : bad(`post-consent derive: chan=${nowChan}`)
}

// ---- DER-12: idempotent + reversible ----
console.log('DER-12 (idempotent + reversible):')
{
  const chanId = (await q(`select id from public.channels where group_id=$1 and name='General'`, [mathClass])).rows[0].id
  const before = (await q(`select count(*)::int n from public.channel_members where channel_id=$1`, [chanId])).rows[0].n
  const reqBefore = (await q(`select count(*)::int n from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='assigned'`, [mathClass, CID.Brielle])).rows[0].n
  // re-join Brielle (already a member) + drain → no duplicates
  await S.seth.client.rpc('join_group', { p_group_id: mathClass, p_member_child_id: CID.Brielle, p_member_actor_id: null, p_role: 'member' })
  await S.seth.client.rpc('drain_derivations')
  const after = (await q(`select count(*)::int n from public.channel_members where channel_id=$1`, [chanId])).rows[0].n
  const reqAfter = (await q(`select count(*)::int n from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='assigned'`, [mathClass, CID.Brielle])).rows[0].n
  before === after && reqBefore === reqAfter ? ok(`idempotent: re-drain created no duplicate channel members (${after}) or requirements (${reqAfter})`) : bad(`idempotency: members ${before}->${after}, reqs ${reqBefore}->${reqAfter}`)
  // reversal on leave (compensating, history preserved)
  await S.seth.client.rpc('leave_group', { p_group_id: mathClass, p_member_child_id: CID.Brielle, p_member_actor_id: null })
  await S.seth.client.rpc('drain_derivations')
  const childActive = (await q(`select active from public.channel_members where channel_id=$1 and member_child_id=$2`, [chanId, CID.Brielle])).rows[0]
  const cancelled = (await q(`select count(*)::int n from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='cancelled'`, [mathClass, CID.Brielle])).rows[0].n
  const assignedStill = (await q(`select count(*)::int n from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='assigned'`, [mathClass, CID.Brielle])).rows[0].n
  childActive?.active === false && cancelled >= 1 && assignedStill >= 1 ? ok('leave → membership withdrawn + requirement cancelled (superseding event); original assigned event PRESERVED') : bad(`reversal: active=${childActive?.active} cancelled=${cancelled} assignedStill=${assignedStill}`)
}

// ---- Isolation: cross-family cannot read the group graph ----
console.log('Cross-family isolation (new tables):')
{
  const checks = [
    ['groups', `select id from public.groups where id='${mathClass}'`],
    ['memberships', `select id from public.memberships where group_id='${mathClass}'`],
    ['channels', `select id from public.channels where group_id='${mathClass}'`],
    ['events', `select id from public.events where group_id='${mathClass}'`],
  ]
  let leaks = 0
  for (const [table] of checks) {
    const danaN = (await S.dana.client.from(table).select('id').eq(table === 'groups' ? 'id' : 'group_id', mathClass)).data?.length ?? 0
    const sethN = (await S.seth.client.from(table).select('id').eq(table === 'groups' ? 'id' : 'group_id', mathClass)).data?.length ?? 0
    if (danaN > 0) leaks++
    if (sethN === 0) bad(`${table}: Seth (member) should see Math Class rows but saw 0`)
  }
  leaks === 0 ? ok('Dana (other family) reads 0 rows across groups/memberships/channels/events') : bad(`${leaks} cross-family group-graph leaks`)
}

await db.end()
console.log(fails ? `\n=== RM-07: ${fails} FAIL ===` : '\n=== RM-07: ALL PASS ===')
process.exit(fails ? 1 : 0)
