// ============================================================================
// RM-23 family standing + add/delete soft-cap (Slice B4).
//   1. record_family_flag escalates a FAMILY's standing; the parent reads their
//      own (RLS), another family can't.
//   2. family_muted resolves any actor (parent OR their child) to the family head.
//   3. a muted family can't post_message.
//   4. ANTI-EVASION: standing is parent-keyed and SURVIVES both a child deletion
//      and a whole-account deletion (so delete+re-add / delete+re-signup can't
//      reset a sanction).
//   5. add/delete SOFT-CAP: over 10 family ops (grants+deletes)/30d, create_pending_child
//      refuses a NEW add (deletes are never blocked).
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm23-family-standing-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'

let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Wren: B.children.wren.childId }

console.log('Setup…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const brielle = await mintChildSession(cfg, seth.client, CID.Brielle)

try {
  // ---- set up a channel Seth belongs to (for the post_message gate) ----
  const gid = (await q(`insert into public.groups (purpose, name, created_by) values ('family','Fam',$1) returning id`, [uids.seth]))[0].id
  const chid = (await q(`insert into public.channels (group_id, name) values ($1,'general') returning id`, [gid]))[0].id
  await q(`insert into public.channel_members (channel_id, member_actor_id, active) values ($1,$2,true)`, [chid, uids.seth])

  // ---- 3a. post_message works before any sanction ----
  const pm1 = await seth.client.rpc('post_message', { p_channel_id: chid, p_context_ref_kind: 'thread', p_context_ref_id: uuid(), p_body: 'hello' })
  pm1.data?.ok === true ? ok('post_message works for a family in good standing') : bad(`pre-mute post: ${JSON.stringify(pm1.data)}`)

  // ---- 1. record_family_flag + escalation + parent-read RLS ----
  await q(`select public.record_family_flag($1,'spam',60)`, [uids.seth]) // flag + 60m mute
  const sethSees = (await seth.client.from('family_standing').select('flags, standing, muted_until')).data ?? []
  const danaSeesSeth = (await dana.client.from('family_standing').select('parent_id')).data ?? []
  sethSees.length === 1 && sethSees[0].flags === 1 && danaSeesSeth.length === 0
    ? ok('record_family_flag written; parent reads their OWN standing; another family sees nothing')
    : bad(`standing read: seth=${JSON.stringify(sethSees)} dana=${danaSeesSeth.length}`)

  // ---- 2. family_muted resolves parent AND child to the family head ----
  const mutedParent = (await q(`select public.family_muted($1) m`, [uids.seth]))[0].m
  const mutedChild = (await q(`select public.family_muted($1) m`, [uids.brielle]))[0].m // child of Seth
  const mutedOther = (await q(`select public.family_muted($1) m`, [uids.dana]))[0].m
  mutedParent && mutedChild && !mutedOther
    ? ok('family_muted true for the parent AND their child, false for another family') : bad(`muted: parent=${mutedParent} child=${mutedChild} other=${mutedOther}`)

  // ---- 3b. a muted family can't post_message ----
  const pm2 = await seth.client.rpc('post_message', { p_channel_id: chid, p_context_ref_kind: 'thread', p_context_ref_id: uuid(), p_body: 'again' })
  pm2.data?.ok === false && pm2.data?.error === 'muted' ? ok('a muted family is blocked from post_message') : bad(`muted post: ${JSON.stringify(pm2.data)}`)

  // ---- 4a. ANTI-EVASION: standing survives a CHILD deletion ----
  await q(`select public.purge_child($1,$2,$3)`, [CID.Brielle, uids.seth, uids.seth])
  const survivesChildDel = (await q(`select count(*)::int n from public.family_standing where parent_id=$1 and (standing='suspended' or muted_until > now())`, [uids.seth]))[0].n === 1
  survivesChildDel ? ok('family standing SURVIVES a child deletion (delete+re-add can’t reset it)') : bad('standing lost on child delete')

  // ---- escalate to suspended (5 flags) ----
  for (let i = 0; i < 4; i++) await q(`select public.record_family_flag($1,'repeat',0)`, [uids.seth])
  const suspended = (await q(`select standing from public.family_standing where parent_id=$1`, [uids.seth]))[0].standing === 'suspended'
  suspended ? ok('standing escalates to suspended on cumulative flags') : bad('did not suspend at 5 flags')

  // ---- 4b. ANTI-EVASION: standing survives a whole-ACCOUNT deletion ----
  await q(`select public.purge_account($1,$2)`, [uids.seth, uids.seth])
  const survivesAcctDel = (await q(`select count(*)::int n from public.family_standing where parent_id=$1 and standing='suspended'`, [uids.seth]))[0].n === 1
  survivesAcctDel ? ok('family standing SURVIVES a whole-account deletion (re-signup with the same login stays suspended)') : bad('standing lost on account delete')

  // ---- 5. add/delete soft-cap (Dana) ----
  const under = await dana.client.rpc('create_pending_child', { p_nickname: 'UnderCap', p_grade_band: null })
  // push Dana to the 30d op cap with synthetic consent grants (she has Wren = 1)
  await q(`insert into public.consent_ledger (parent_id, child_id, action, method, policy_version) select $1, gen_random_uuid(), 'grant','other_vpc','v1' from generate_series(1,10)`, [uids.dana])
  const over = await dana.client.rpc('create_pending_child', { p_nickname: 'OverCap', p_grade_band: null })
  under.data?.ok === true && over.data?.ok === false && over.data?.error === 'add_cap_reached'
    ? ok('add/delete soft-cap: adds allowed under the 30d cap, refused once the family exceeds it')
    : bad(`soft-cap: under=${JSON.stringify(under.data)} over=${JSON.stringify(over.data)}`)
} finally {
  await db.end()
}
console.log(fails ? `\n=== RM-23 FAMILY STANDING: ${fails} FAIL ===` : '\n=== RM-23 FAMILY STANDING: ALL PASS (family-level sanctions; anti-evasion; add cap) ===')
process.exit(fails ? 1 : 0)
