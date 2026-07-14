// ============================================================================
// RM-43 Realtime channel isolation (Phase 5 · Slice 2 · C-obs2). The END-TO-END proof
// that live Postgres-Changes subscriptions on grade_proposals (the only table in the
// supabase_realtime publication; GradeReview.tsx) do NOT leak across children or families.
// Realtime delivers a change only to a subscriber that can SELECT the row under RLS; the
// client-side channel `filter` is NOT a security boundary. This subscribes FOUR real roles,
// inserts ONE proposal for child A1, and asserts only the reviewer (parent A) receives it —
// the subject child (SAF), a sibling child, and the other family receive NOTHING.
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm43-realtime-isolation-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'

let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

console.log('Setup family + mint child sessions…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)

const seth = await signInAs(cfg, A.parent.email)  // reviewer (parent A) — CAN view A1
const dana = await signInAs(cfg, B.parent.email)  // other family (parent B)
const brielle = await mintChildSession(cfg, seth.client, CID.Brielle) // the SUBJECT child (A1)
const theo = await mintChildSession(cfg, seth.client, CID.Theo)       // a SIBLING child (A2)

// one real subscription per role; resolves when SUBSCRIBED (or rejects on error/timeout).
// The role's JWT is fed to the Realtime socket via the top-level accessToken option (the
// canonical v2 mechanism) AND setAuth — so Realtime evaluates RLS AS THIS USER, not anon.
const clients = []
const subscribe = async (token, label) => {
  const c = createClient(cfg.apiUrl, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: async () => token,
  })
  await c.realtime.setAuth(token)
  return await new Promise((resolve, reject) => {
    const received = []
    const ch = c.channel(`rt-${label}-${uuid()}`)
      // event:'*' matches the real consumer (GradeReview.tsx) — covers INSERT + UPDATE
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grade_proposals', filter: `child_id=eq.${CID.Brielle}` }, (p) => received.push(p))
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve({ label, received })
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') reject(new Error(`${label}: ${status} ${err ?? ''}`))
      })
    clients.push({ c, ch })
    setTimeout(() => reject(new Error(`${label}: subscribe timeout`)), 20000)
  })
}

try {
  // publication invariant on the LIVE stack: grade_proposals streams AND forces RLS
  const pub = await q(`
    select t.tablename, c.relrowsecurity rls, c.relforcerowsecurity force
      from pg_publication_tables t
      join pg_namespace n on n.nspname = t.schemaname
      join pg_class c on c.relname = t.tablename and c.relnamespace = n.oid
     where t.pubname = 'supabase_realtime'`)
  const gp = pub.find((r) => r.tablename === 'grade_proposals')
  gp && gp.rls && gp.force && pub.every((r) => r.rls && r.force)
    ? ok(`publication invariant: grade_proposals streams live AND every published table FORCES RLS (${pub.length} table(s))`)
    : bad(`publication: ${JSON.stringify(pub)}`)

  // seed an upload + grade_job for A1 (neither is on the realtime publication → no event yet)
  const up = (await q(`insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
     values ($1::uuid,$1::uuid,'parent',$2,'image/jpeg',1,true,'inbox') returning id`, [CID.Brielle, `${CID.Brielle}/rt.jpg`]))[0].id
  const job = (await q(`insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, client_job_id)
     values ($1,$2,'mult2','{}'::jsonb, gen_random_uuid()) returning id`, [CID.Brielle, up]))[0].id

  // four real subscriptions, all filtered to child A1 (as a malicious client would try)
  const subs = await Promise.all([
    subscribe(seth.session.access_token, 'reviewerA'),
    subscribe(dana.session.access_token, 'familyB'),
    subscribe(brielle.session.access_token, 'subjectChild'),
    subscribe(theo.session.access_token, 'siblingChild'),
  ])
  ok('4 realtime subscriptions established (all SUBSCRIBED, all filtered to child A1)')
  const reviewer = subs.find((s) => s.label === 'reviewerA')
  await sleep(1500) // postgres_changes: let the WAL filters wire up AFTER SUBSCRIBED (a fixed sleep races)

  // the ONLY realtime-published change: a grade_proposal lands for child A1
  await q(`insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, provider)
     values ($1,$2,$3,'mult2',42,'mock')`, [job, CID.Brielle, up])
  // poll until the reviewer receives it (positive control), then settle so any erroneous
  // cross-subscriber delivery would also have arrived — makes the negative zeros meaningful
  for (let i = 0; i < 30 && reviewer.received.length === 0; i++) await sleep(500)
  await sleep(1500)

  const n = Object.fromEntries(subs.map((s) => [s.label, s.received.length]))
  // PER-SOCKET IDENTITY CONTROL — prove every socket's token is a valid session bound to its
  // OWN user (not anon). Without this, a socket that silently degraded to anon would receive 0
  // and read as perfect isolation. reviewerA additionally proves the accessToken mechanism
  // binds the JWT end-to-end (it was DELIVERED A1's row, which requires RLS-as-parent-A).
  const probe = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let idOk = true
  for (const [label, token, expectedUid] of [
    ['reviewerA', seth.session.access_token, seth.uid],
    ['familyB', dana.session.access_token, dana.uid],
    ['subjectChild', brielle.session.access_token, brielle.uid],
    ['siblingChild', theo.session.access_token, theo.uid],
  ]) {
    const { data } = await probe.auth.getUser(token)
    if (data?.user?.id !== expectedUid) { idOk = false; bad(`${label} socket token is NOT a valid session for the expected user (got ${data?.user?.id}, want ${expectedUid})`) }
  }
  idOk && ok('every subscriber socket carries a valid session bound to its own user (no silent anon-degrade) — the zeros below are real isolation')

  // POSITIVE control — proves the pipe works, so the zeros below are isolation, not a dead socket
  n.reviewerA >= 1
    ? ok(`reviewer (parent A) received child A1's live proposal (positive control, n=${n.reviewerA})`)
    : bad(`reviewer received ${n.reviewerA} — pipe broken? (positive control failed)`)
  n.familyB === 0
    ? ok('cross-FAMILY: parent B received NOTHING, even subscribed filtered to A1 (channel filter is not a boundary; RLS is)')
    : bad(`cross-family leak: parent B received ${n.familyB}`)
  n.subjectChild === 0
    ? ok('SUBJECT child (SAF): child A1 received NOTHING about its own unmoderated proposal')
    : bad(`subject-child leak: A1 received ${n.subjectChild}`)
  n.siblingChild === 0
    ? ok('cross-CHILD: sibling A2 received NOTHING about A1')
    : bad(`sibling leak: A2 received ${n.siblingChild}`)

  // UPDATE delivery ('*' path the real consumer uses): a status flip on A1's proposal must
  // reach the reviewer and NO ONE else — proves live UPDATEs isolate the same as INSERTs.
  await q(`update public.grade_proposals set read_answer = 43 where job_id = $1`, [job])
  for (let i = 0; i < 20 && reviewer.received.length <= n.reviewerA; i++) await sleep(500)
  await sleep(1000)
  const u = Object.fromEntries(subs.map((s) => [s.label, s.received.length]))
  u.reviewerA > n.reviewerA && u.familyB === 0 && u.subjectChild === 0 && u.siblingChild === 0
    ? ok(`live UPDATE ('*' path): reviewer received the update (${n.reviewerA}→${u.reviewerA}); subject/sibling/other-family still 0`)
    : bad(`update path: reviewer ${n.reviewerA}→${u.reviewerA} familyB=${u.familyB} subject=${u.subjectChild} sibling=${u.siblingChild}`)
} catch (e) {
  bad(`realtime e2e error: ${String(e?.message ?? e)}`)
} finally {
  for (const { c, ch } of clients) { try { await c.removeChannel(ch) } catch { /* */ } try { c.realtime.disconnect() } catch { /* */ } }
  await db.end()
}
console.log(fails ? `\n=== RM-43 REALTIME ISOLATION: ${fails} FAIL ===` : '\n=== RM-43 REALTIME ISOLATION: ALL PASS (publication forces RLS; only a reviewer receives a child’s live proposal; subject-child/sibling/other-family receive nothing) ===')
process.exit(fails ? 1 : 0)
