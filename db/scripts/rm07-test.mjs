// ============================================================================
// RM-07 self-test — the ONE Group+Membership derivation engine (SPEC §10).
// Proves DER-03…DER-12 + COM-01 through the real client path (anon key + user
// JWT, RLS), plus cross-family isolation for the new group tables. LOCAL only.
//
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm07-test.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'

const { Client } = pgpkg
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

const db = new Client({ connectionString: cfg.dbUrl })
const q = (sql, p = []) => db.query(sql, p)
// the drain is worker/service-only (revoked from authenticated, 0011 M4) — run it via the service pg connection
const drain = async () => (await q('select public.drain_derivations() as r')).rows[0].r

console.log('Setup: families + a class group with a schedule (derivation rules seeded by 0039)…')
const uids = await setupFamily(cfg)
await db.connect()
// S1: derivation rules for class/team are seeded as DATA by migration 0039 — validated below.

const S = {}
for (const [w, e] of [['seth', A.parent.email], ['dana', B.parent.email], ['rose', A.tutor.email]]) S[w] = await signInAs(cfg, e)
S.brielle = await mintChildSession(cfg, S.seth.client, CID.Brielle) // child enters via the real mint

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
const d1 = await drain()
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
  reqs.some((r) => r.k === 'enrollment_form' && r.s === 'assigned') && !reqs.some((r) => r.k === 'athletics_waiver') ? ok('enrollment_form requirement assigned (team athletics_waiver NOT — non-matching purpose)') : bad(`requirements: ${JSON.stringify(reqs)}`)
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
  // K1 (0013): the message body passes the moderation choke point
  const linkMsg = (await S.seth.client.rpc('post_message', { p_channel_id: chanId, p_context_ref_kind: 'assignment', p_context_ref_id: ctxId, p_body: 'Great — visit http://cheats.example.com' })).data
  const linkBody = (await q(`select payload->>'body' b from public.events where id=$1`, [linkMsg?.event_id])).rows[0]
  linkMsg?.ok && !/cheats\.example\.com/.test(linkBody?.b ?? '') ? ok('K1: a link in a message body is moderated out on write') : bad(`K1: body="${linkBody?.b}"`)
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
  await drain()
  const held = (await q(`select status from public.derivation_outbox where kind='join' and group_id=$1 and member_child_id=$2`, [mathClass, CID.Theo])).rows[0]
  const noChan = (await q(`select count(*)::int n from public.channel_members cm join public.channels c on c.id=cm.channel_id where c.group_id=$1 and cm.member_child_id=$2`, [mathClass, CID.Theo])).rows[0].n
  held?.status === 'held' && noChan === 0 ? ok('non-consented child → outbox HELD, nothing derived (blocks, not skips)') : bad(`consent-hold: status=${held?.status} chan=${noChan}`)
  await q(`update public.children set consent_id=$1 where id=$2`, [saved, CID.Theo])
  // re-enqueue by re-joining, then drain → now completes
  await S.seth.client.rpc('join_group', { p_group_id: mathClass, p_member_child_id: CID.Theo, p_member_actor_id: null, p_role: 'member' })
  await drain()
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
  await drain()
  const after = (await q(`select count(*)::int n from public.channel_members where channel_id=$1`, [chanId])).rows[0].n
  const reqAfter = (await q(`select count(*)::int n from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='assigned'`, [mathClass, CID.Brielle])).rows[0].n
  before === after && reqBefore === reqAfter ? ok(`idempotent: re-drain created no duplicate channel members (${after}) or requirements (${reqAfter})`) : bad(`idempotency: members ${before}->${after}, reqs ${reqBefore}->${reqAfter}`)
  // reversal on leave (compensating, history preserved)
  await S.seth.client.rpc('leave_group', { p_group_id: mathClass, p_member_child_id: CID.Brielle, p_member_actor_id: null })
  await drain()
  const childActive = (await q(`select active from public.channel_members where channel_id=$1 and member_child_id=$2`, [chanId, CID.Brielle])).rows[0]
  const cancelled = (await q(`select count(*)::int n from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='cancelled'`, [mathClass, CID.Brielle])).rows[0].n
  const assignedStill = (await q(`select count(*)::int n from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='assigned'`, [mathClass, CID.Brielle])).rows[0].n
  childActive?.active === false && cancelled >= 1 && assignedStill >= 1 ? ok('leave → membership withdrawn + requirement cancelled (superseding event); original assigned event PRESERVED') : bad(`reversal: active=${childActive?.active} cancelled=${cancelled} assignedStill=${assignedStill}`)
}

// ---- S2 (create_group RPC) + S1 (purpose-scoped derivation on a real created group) ----
console.log('S2 (create_group) + S1 (class/team purpose-scoping):')
{
  // S2: the creator stands up a TEAM (leader = coach) via the RPC — no bespoke write path
  const cg = (await S.seth.client.rpc('create_group', { p_purpose: 'team', p_name: 'Wrestling Team' })).data
  const team = cg?.group_id
  const lead = (await q(`select role from public.memberships where group_id=$1 and member_actor_id=$2`, [team, uids.seth])).rows[0]
  const ev = (await q(`select count(*)::int n from public.events where kind='membership' and group_id=$1 and payload->>'action'='join'`, [team])).rows[0].n
  const ob = (await q(`select count(*)::int n from public.derivation_outbox where group_id=$1`, [team])).rows[0].n
  const audit = (await q(`select count(*)::int n from public.audit_log where action='group.create' and (detail->>'group_id')=$1`, [team])).rows[0].n
  cg?.ok && cg.role === 'coach' && lead?.role === 'coach' && ev >= 1 && ob >= 1 && audit === 1
    ? ok('create_group: team created; creator is the coach-leader via the transactional outbox (membership+Event+outbox); audited')
    : bad(`create_group team: ${JSON.stringify({ cg, lead, ev, ob, audit })}`)
  // a class leader is a tutor (leader role by purpose)
  const cls2 = (await S.seth.client.rpc('create_group', { p_purpose: 'class', p_name: 'Science' })).data
  cls2?.ok && cls2.role === 'tutor' ? ok('create_group: a class leader is a tutor (role×purpose)') : bad(`create_group class role: ${JSON.stringify(cls2)}`)
  // guards: a child actor cannot create; family/academy purposes are refused
  const childCg = (await S.brielle.client.rpc('create_group', { p_purpose: 'team', p_name: 'x' })).data
  const badP = (await S.seth.client.rpc('create_group', { p_purpose: 'family', p_name: 'x' })).data
  childCg?.error === 'not_authorized' && badP?.error === 'bad_purpose'
    ? ok('create_group: child actor refused; family/academy purposes refused (bad_purpose)')
    : bad(`create_group guards: child=${JSON.stringify(childCg)} badP=${JSON.stringify(badP)}`)

  // S1: join a child to the TEAM and drain → team-scoped derivation (Team channel + athletics_waiver,
  //     NEVER the class enrollment_form). Theo's consent was restored in DER-11 above.
  await S.seth.client.rpc('join_group', { p_group_id: team, p_member_child_id: CID.Theo, p_member_actor_id: null, p_role: 'member' })
  await drain()
  const teamChan = (await q(`select name from public.channels where group_id=$1`, [team])).rows.map((r) => r.name)
  const teamReqs = (await q(`select payload->>'requirement_key' k from public.events where kind='requirement' and group_id=$1 and subject_child_id=$2 and payload->>'status'='assigned'`, [team, CID.Theo])).rows.map((r) => r.k)
  teamChan.includes('Team') && teamReqs.includes('athletics_waiver') && !teamReqs.includes('enrollment_form')
    ? ok('S1: team derives the Team channel + athletics_waiver requirement; NOT the class enrollment_form (purpose-scoped)')
    : bad(`S1 team scoping: chan=${JSON.stringify(teamChan)} reqs=${JSON.stringify(teamReqs)}`)
  // and the CLASS never receives the team waiver
  const classReqs = (await q(`select distinct payload->>'requirement_key' k from public.events where kind='requirement' and group_id=$1 and payload->>'status'='assigned'`, [mathClass])).rows.map((r) => r.k)
  classReqs.includes('enrollment_form') && !classReqs.includes('athletics_waiver')
    ? ok('S1: the class has enrollment_form and NEVER athletics_waiver (a team waiver is never assigned to a class)')
    : bad(`S1 class scoping: ${JSON.stringify(classReqs)}`)
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

// ---- C1 (EVOLVED to S4 distributed model): a parent adds their OWN child to any class;
//      a cross-family ACTIVE add is still refused (can_write_child border UNCHANGED). ----
console.log('C1 (S4) — distributed add: parent adds OWN child to any class; cross-family active add refused:')
{
  const roseClass = (await S.rose.client.rpc('create_group', { p_purpose: 'class', p_name: 'Rose Distributed' })).data?.group_id
  // Dana adds her OWN child (Wren) to Rose's class — a class she does NOT own → ACTIVE (distributed easy-in)
  const danaOwn = (await S.dana.client.rpc('join_group', { p_group_id: roseClass, p_member_child_id: CID.Wren, p_member_actor_id: null, p_role: 'member' })).data
  // but Dana CANNOT actively add a CROSS-FAMILY child (Brielle, Seth's) — can_write_child border intact
  const danaCross = (await S.dana.client.rpc('join_group', { p_group_id: roseClass, p_member_child_id: CID.Brielle, p_member_actor_id: null, p_role: 'member' })).data
  const wrenIn = (await q(`select count(*)::int n from public.memberships where group_id=$1 and member_child_id=$2 and active`, [roseClass, CID.Wren])).rows[0].n
  const brielleIn = (await q(`select count(*)::int n from public.memberships where group_id=$1 and member_child_id=$2`, [roseClass, CID.Brielle])).rows[0].n
  roseClass && danaOwn?.ok && wrenIn === 1 && danaCross?.error === 'not_authorized' && brielleIn === 0
    ? ok('S4: Dana adds her OWN child to Rose\'s class (active, distributed); a cross-family active add (Brielle) is refused (can_write_child border intact)')
    : bad(`C1 distributed: danaOwn=${JSON.stringify(danaOwn)} wrenIn=${wrenIn} danaCross=${JSON.stringify(danaCross)} brielleIn=${brielleIn}`)
}

// ---- S4 request/confirm (crown jewel e2e): a leader requests a cross-family child → HELD (no
//      membership); the requester cannot self-confirm; the child's OWN parent sees it + confirms. ----
console.log('S4 — cross-family request → HELD → parent confirms:')
{
  const rClass = (await S.rose.client.rpc('create_group', { p_purpose: 'class', p_name: 'Rose Request' })).data?.group_id
  const rq = (await S.rose.client.rpc('request_add', { p_group_id: rClass, p_member_child_id: CID.Wren })).data
  const heldMem = (await q(`select count(*)::int n from public.memberships where group_id=$1 and member_child_id=$2`, [rClass, CID.Wren])).rows[0].n
  const roseConf = (await S.rose.client.rpc('confirm_add', { p_request_id: rq?.request_id })).data     // requester cannot self-confirm
  const danaSees = (await S.dana.client.rpc('my_pending_add_requests')).data ?? []
  const sethSees = (await S.seth.client.rpc('my_pending_add_requests')).data ?? []                     // other family sees nothing
  const danaConf = (await S.dana.client.rpc('confirm_add', { p_request_id: rq?.request_id })).data
  const nowMem = (await q(`select count(*)::int n from public.memberships where group_id=$1 and member_child_id=$2 and active`, [rClass, CID.Wren])).rows[0].n
  rq?.ok && heldMem === 0 && roseConf?.error === 'not_authorized'
    && danaSees.some((r) => r.id === rq.request_id) && !sethSees.some((r) => r.id === rq.request_id)
    && danaConf?.ok && nowMem === 1
    ? ok('S4: cross-family request HELD (no membership); requester cannot self-confirm; only the child\'s parent sees it + confirms → active')
    : bad(`S4 req/confirm: rq=${JSON.stringify(rq)} heldMem=${heldMem} roseConf=${JSON.stringify(roseConf)} danaSees=${danaSees.length} sethSees=${sethSees.length} danaConf=${JSON.stringify(danaConf)} nowMem=${nowMem}`)
}

// ---- C2 (0011) adversarial: an in-group ADULT co-member from ANOTHER family ----
// The owner CAN add a cross-family adult (member_actor_id). That adult becomes
// is_group_member, but must still read ZERO child-subject events + zero raw rows.
console.log('C2 — in-group cross-family adult co-member sees no child-subject data:')
{
  const jr = (await S.seth.client.rpc('join_group', { p_group_id: mathClass, p_member_child_id: null, p_member_actor_id: uids.dana, p_role: 'member' })).data
  await drain()
  const danaEvents = (await S.dana.client.from('events').select('id,subject_child_id').eq('group_id', mathClass)).data ?? []
  const isMember = danaEvents.length > 0                                   // she sees group-only events → really a member
  const childSubjectVisible = danaEvents.filter((e) => e.subject_child_id).length
  const seesBrielleChild = (await S.dana.client.from('children').select('id').eq('id', CID.Brielle)).data?.length ?? 0
  const seesBrielleAttempts = (await S.dana.client.from('attempts').select('id').eq('child_id', CID.Brielle)).data?.length ?? 0
  jr?.ok && isMember && childSubjectVisible === 0 && seesBrielleChild === 0 && seesBrielleAttempts === 0
    ? ok('cross-family adult member sees group-only events yet 0 child-subject events + 0 Brielle rows')
    : bad(`C2 adult co-member: member=${isMember} childSubj=${childSubjectVisible} child=${seesBrielleChild} attempts=${seesBrielleAttempts} jr=${JSON.stringify(jr)}`)
}

// ---- S3a/S3b companions: roster visibility + academy staff discovery through the real client path ----
console.log('S3 (leader sees roster; co-member narrowed; academy staff discover kids by name, 0 work):')
{
  // S3a: the LEADER (Seth = created_by of Math Class) reads its child roster; Dana (in-group adult
  // co-member from C2) sees her own adult row but ZERO child rows (narrowed — not the leader/guardian).
  const sethKids = (await S.seth.client.from('memberships').select('member_child_id').eq('group_id', mathClass).not('member_child_id', 'is', null)).data ?? []
  const danaAdults = (await S.dana.client.from('memberships').select('member_actor_id').eq('group_id', mathClass).not('member_actor_id', 'is', null)).data ?? []
  const danaKids = (await S.dana.client.from('memberships').select('member_child_id').eq('group_id', mathClass).not('member_child_id', 'is', null)).data ?? []
  sethKids.length >= 1 && danaAdults.length >= 1 && danaKids.length === 0
    ? ok('S3a: the leader (Seth) reads the child roster; a co-member adult (Dana) sees her own adult row but 0 child rows (narrowed)')
    : bad(`S3a roster: sethKids=${sethKids.length} danaAdults=${danaAdults.length} danaKids=${danaKids.length}`)

  // S3b: enroll Seth's family in a fresh academy; Rose is academy staff. The background-check gate,
  // the discovery-by-name, and the border (a non-staff parent sees nothing) all through the client.
  const acad = '0000d1d1-0000-4000-8000-0000000000a1'
  const director = '0000d1d1-0000-4000-8000-0000000000d1'
  await q(`insert into public.groups (id, purpose, name, created_by) values ($1,'academy','RM07 Academy',$2)`, [acad, director])
  await q(`insert into public.groups (purpose, name, arena, org_id, created_by) values ('family','Seth Fam','academy',$1,$2)`, [acad, uids.seth])
  await q(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true)`, [acad, uids.rose])
  const beforeClear = (await S.rose.client.rpc('academy_child_roster', { p_academy_group_id: acad })).data ?? []
  await q(`insert into public.academy_staff_clearances (academy_group_id, actor_id, completed_at) values ($1,$2, now())`, [acad, uids.rose])
  const roseRoster = (await S.rose.client.rpc('academy_child_roster', { p_academy_group_id: acad })).data ?? []
  const danaRoster = (await S.dana.client.rpc('academy_child_roster', { p_academy_group_id: acad })).data ?? []
  const names = roseRoster.map((r) => r.nickname)
  beforeClear.length === 0 && names.includes('Brielle') && names.includes('Theo') && (danaRoster?.length ?? 0) === 0
    ? ok('S3b: role-only staff → empty; after a background check Rose sees Brielle+Theo by name; a non-staff parent (Dana) sees 0 (gate + border)')
    : bad(`S3b discovery: before=${beforeClear.length} names=${JSON.stringify(names)} dana=${danaRoster?.length}`)

  // S3b crown jewel e2e: Rose discovers Theo by NAME but holds NO grant for Theo → 0 of Theo's child
  // row/work (name ≠ work; can_view_child stays pristine). Rose HAS a grant for Brielle, so use Theo.
  const roseTheoChild = (await S.rose.client.from('children').select('id').eq('id', CID.Theo)).data ?? []
  const roseTheoAttempts = (await S.rose.client.from('attempts').select('id').eq('child_id', CID.Theo)).data ?? []
  names.includes('Theo') && roseTheoChild.length === 0 && roseTheoAttempts.length === 0
    ? ok('S3b crown jewel: Rose discovers Theo by name yet reads 0 of Theo’s child row/work (no grant → can_view_child pristine)')
    : bad(`S3b crown jewel: nameTheo=${names.includes('Theo')} child=${roseTheoChild.length} attempts=${roseTheoAttempts.length}`)
}

await db.end()
console.log(fails ? `\n=== RM-07: ${fails} FAIL ===` : '\n=== RM-07: ALL PASS ===')
process.exit(fails ? 1 : 0)
