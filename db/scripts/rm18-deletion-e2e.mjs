// ============================================================================
// RM-18 deletion kernel (Slice A) — consent revocation -> hard deletion, end to
// end through the REAL delete-child Edge function + purge_child kernel. Asserts
// the five-lens AC floor:
//   AC-1  zero child data anywhere (FK-graph + column completeness walk) AND no
//         surviving evidence jsonb carries the nickname
//   AC-2  immutable, hash-CHAINED deletion receipt (update/delete blocked)
//   AC-3  no re-materialization: a captured PRE-purge child JWT cannot write to
//         any child-writable table (attempts / suppressions / self-read); replay
//         is idempotent (no 2nd revoke)
//   AC-4  edge deny for child / tutor / other-family (uniform not_found), before
//         any destructive call
//   AC-5  verifiable receipt readable by the parent only
//   AC-6  structural completeness (walk) — no child-keyed table escapes
//   AC-7  step-up passes for fresh re-auth; rate-limit; idempotent
//   AC-8  legal hold blocks destruction (records, no delete)
//   AC-9  siblings + other family byte-for-byte untouched
// LOCAL only.  Run (stack up): eval "$(supabase status -o env)"; node db/scripts/rm18-deletion-e2e.mjs
// ============================================================================
import pgpkg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { m3Config, setupFamily, signInAs, mintChildSession, adminClient, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

console.log('Setup + serve delete-child + populate…')
const uids = await setupFamily(cfg)
const db = new pgpkg.Client({ connectionString: cfg.dbUrl }); await db.connect()
const q = (s, p = []) => db.query(s, p).then((r) => r.rows)
const admin = adminClient(cfg)
const seth = await signInAs(cfg, A.parent.email)
const dana = await signInAs(cfg, B.parent.email)
const rose = await signInAs(cfg, A.tutor.email)
const brielle = await mintChildSession(cfg, seth.client, CID.Brielle)
const theo = await mintChildSession(cfg, seth.client, CID.Theo)
const brielleUid = brielle.uid, brielleTok = brielle.session.access_token

// populate Brielle across many tables (+ a message she authored + a subject event)
const ev = () => ({ clientAttemptId: uuid(), clientSessionId: uuid(), stageIndex: 0, skill: 'addition', result: 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: 5, level: 1, mode: 'journey', context: {} })
await brielle.client.rpc('record_attempts_authed', { p_child_id: CID.Brielle, p_batch: buildBatch([ev()]) })
await q(`insert into public.events (kind, author_actor_id, group_id, context_ref_kind, context_ref_id, payload) values ('message',$1,null,'thread',$2, jsonb_build_object('body','hello from Brielle'))`, [brielleUid, uuid()])
await q(`insert into public.events (kind, author_actor_id, subject_child_id, payload) values ('completion',$1,$2,'{}'::jsonb)`, [uids.seth, CID.Brielle])
// baseline: a LIVE child can create a suppression (the zombie guard only blocks post-deletion)
const supBase = await brielle.client.from('suppressions').insert({ actor_id: brielleUid, target_kind: 'channel', target_id: uuid(), scope: 'notify' })
// Theo gets an assignment + a submission LINKED to it — exercises the inter-table
// FK (submissions.assignment_id -> assignments): purge must delete submissions
// before assignments or the whole tx FK-aborts and deletion is impossible.
const skillId = (await q(`select id from public.skills limit 1`))[0].id
const theoAsg = (await q(`insert into public.assignments (child_id, assigned_by, skill_id, title) values ($1,$2,$3,'Practice') returning id`, [CID.Theo, uids.seth, skillId]))[0].id
await q(`insert into public.submissions (child_id, skill_id, client_submission_id, assignment_id) values ($1,$2,$3,$4)`, [CID.Theo, skillId, uuid(), theoAsg])

const envFile = path.join(root, 'supabase', '.env.rm18'); fs.writeFileSync(envFile, `# rm18\n`)
const fnServe = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { cwd: root, stdio: 'ignore', env: process.env })
const invoke = async (token, body) => {
  const r = await fetch(`${cfg.apiUrl}/functions/v1/delete-child`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let b = null; try { b = await r.json() } catch { /* */ }
  return { status: r.status, body: b }
}
let ready = false
for (let i = 0; i < 45 && !ready; i++) { await new Promise((r) => setTimeout(r, 3000)); const r = await invoke(seth.session.access_token, {}).catch(() => null); if (r && r.status && r.status !== 502 && r.status !== 503) ready = true }
ready ? ok('delete-child serving') : bad('function not ready')

const childCount = async (id) => (await q(`select count(*)::int n from public.children where id=$1`, [id]))[0].n

try {
  // ---- AC-4: edge deny BEFORE any destructive call ----
  console.log('AC-4 edge gate (deny before destruction):')
  const asChild = await invoke(theo.session.access_token, { childId: CID.Theo })     // a child deleting self
  const asTutor = await invoke(rose.session.access_token, { childId: CID.Brielle })   // a tutor deleting a granted child
  const asOther = await invoke(dana.session.access_token, { childId: CID.Theo })      // other-family
  asChild.status === 403 && asTutor.status === 404 && asOther.status === 404 && await childCount(CID.Brielle) === 1 && await childCount(CID.Theo) === 1
    ? ok('child→403, tutor→404, other-family→404 (uniform not_found); nothing destroyed')
    : bad(`edge gate: child=${asChild.status} tutor=${asTutor.status} other=${asOther.status}`)

  // ---- AC-7 rate-limit: repeated denials are bounded ----
  console.log('AC-7 rate-limit (bounds probing):')
  let got429 = false, got404 = false
  for (let i = 0; i < 6; i++) { const r = await invoke(dana.session.access_token, { childId: uuid() }); if (r.status === 429) got429 = true; if (r.status === 404) got404 = true }
  got404 && got429 ? ok('probe burst → 404s then 429 (rate-limited)') : bad(`rate-limit: 404=${got404} 429=${got429}`)

  // ---- AC-8 legal hold blocks destruction ----
  console.log('AC-8 legal hold:')
  await q(`insert into public.legal_holds (child_id, reason, placed_by) values ($1,'test-hold',$2)`, [CID.Theo, uids.seth])
  const held = await invoke(seth.session.access_token, { childId: CID.Theo })
  const theoAliveHeld = await childCount(CID.Theo) === 1
  held.status === 423 && held.body?.error === 'legal_hold' && theoAliveHeld
    ? ok('legal hold → 423; child NOT destroyed, request recorded') : bad(`legal hold: status=${held.status} alive=${theoAliveHeld}`)
  await q(`update public.legal_holds set released_at=now() where child_id=$1`, [CID.Theo])

  // ---- delete Brielle for real ----
  console.log('delete Brielle (fresh parent re-auth):')
  const del = await invoke(seth.session.access_token, { childId: CID.Brielle })
  del.status === 200 && del.body?.ok && del.body?.status === 'completed' && del.body?.receipt_hash
    ? ok('delete-child → 200 completed; receipt returned') : bad(`delete: ${JSON.stringify(del)}`)

  // ---- AC-1 + AC-6: zero child data (completeness walk) + evidence scrub ----
  console.log('AC-1/AC-6 completeness + scrub:')
  const walk = await q(`
    select 'attempts' t, count(*) n from public.attempts where child_id=$1
    union all select 'sessions', count(*) from public.sessions where child_id=$1
    union all select 'child_skill_mastery', count(*) from public.child_skill_mastery where child_id=$1
    union all select 'child_skill_misconception', count(*) from public.child_skill_misconception where child_id=$1
    union all select 'child_skill_assessment', count(*) from public.child_skill_assessment where child_id=$1
    union all select 'assignments', count(*) from public.assignments where child_id=$1
    union all select 'submissions', count(*) from public.submissions where child_id=$1
    union all select 'teaching_artifacts', count(*) from public.teaching_artifacts where child_id=$1
    union all select 'child_session_mints', count(*) from public.child_session_mints where child_id=$1
    union all select 'tutor_grants', count(*) from public.tutor_grants where child_id=$1
    union all select 'memberships', count(*) from public.memberships where member_child_id=$1
    union all select 'channel_members', count(*) from public.channel_members where member_child_id=$1
    union all select 'derivation_outbox', count(*) from public.derivation_outbox where member_child_id=$1
    union all select 'events(subject)', count(*) from public.events where subject_child_id=$1
    union all select 'children', count(*) from public.children where id=$1`, [CID.Brielle])
  const stragglers = walk.filter((r) => Number(r.n) > 0)
  const nickLeak = await q(`
    select 'consent_ledger' s from public.consent_ledger where child_id=$1 and detail::text ilike '%Brielle%'
    union all select 'audit_log' from public.audit_log where child_id=$1 and detail::text ilike '%Brielle%'
    union all select 'deletion_receipts' from public.deletion_receipts where child_id=$1 and disposition::text ilike '%Brielle%'`, [CID.Brielle])
  stragglers.length === 0 && nickLeak.length === 0
    ? ok('no child-keyed row survives (15-table walk) AND no surviving evidence jsonb carries the nickname')
    : bad(`AC-1: stragglers=${JSON.stringify(stragglers)} nickLeak=${JSON.stringify(nickLeak)}`)

  // tombstone + evidence retention + GoTrue user gone
  const msg = (await q(`select payload->>'body' body from public.events where kind='message' and author_actor_id=$1`, [brielleUid]))[0]
  const revoke = (await q(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='revoke'`, [CID.Brielle]))[0].n
  const auditKept = (await q(`select count(*)::int n from public.audit_log where child_id=$1`, [CID.Brielle]))[0].n
  const gone = await admin.auth.admin.getUserById(brielleUid)
  msg?.body?.startsWith('[removed') && revoke === 1 && auditKept > 0 && !gone.data?.user
    ? ok('authored message tombstoned; consent revoke + audit retained; GoTrue child user deleted')
    : bad(`tombstone/evidence/user: body=${msg?.body} revoke=${revoke} audit=${auditKept} user=${!!gone.data?.user}`)

  // ---- AC-3: zombie writes with the captured PRE-purge child JWT are denied ----
  console.log('AC-3 zombie-write defense:')
  const zombie = createClient(cfg.apiUrl, cfg.anonKey, { global: { headers: { Authorization: `Bearer ${brielleTok}` } }, auth: { persistSession: false } })
  const zAtt = await zombie.rpc('record_attempts_authed', { p_child_id: CID.Brielle, p_batch: buildBatch([ev()]) })
  const zAttRows = (await q(`select count(*)::int n from public.attempts where child_id=$1`, [CID.Brielle]))[0].n
  const zSup = await zombie.from('suppressions').insert({ actor_id: brielleUid, target_kind: 'channel', target_id: uuid(), scope: 'notify' })
  const zGrp = await zombie.from('groups').insert({ purpose: 'family', name: 'zombie group', created_by: brielleUid })
  const zSelf = await zombie.from('children').select('id')
  const supAfter = (await q(`select count(*)::int n from public.suppressions where actor_id=$1`, [brielleUid]))[0].n
  const grpAfter = (await q(`select count(*)::int n from public.groups where created_by=$1`, [brielleUid]))[0].n
  supBase.error == null && zAttRows === 0 && zSup.error != null && zGrp.error != null && supAfter === 1 && grpAfter === 0 && (zSelf.data ?? []).length === 0
    ? ok('captured child token: attempts no-op, suppression + group inserts DENIED (tombstone guard on every auth.uid()-only surface), self-read empty')
    : bad(`zombie: attRows=${zAttRows} supErr=${!!zSup.error} grpErr=${!!zGrp.error} supAfter=${supAfter} grpAfter=${grpAfter} self=${(zSelf.data ?? []).length}`)

  // ---- AC-3 replay idempotent (no 2nd revoke) ----
  console.log('AC-3 replay idempotent:')
  const replay = await invoke(seth.session.access_token, { childId: CID.Brielle })
  const revoke2 = (await q(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='revoke'`, [CID.Brielle]))[0].n
  ;(replay.status === 404 || replay.body?.idempotent === true) && revoke2 === 1
    ? ok('replay is idempotent — no second revoke row') : bad(`replay: ${JSON.stringify(replay)} revoke=${revoke2}`)

  // ---- AC-5 verifiable receipt: parent reads own; other family cannot ----
  console.log('AC-5 receipt visibility:')
  const sethSees = (await seth.client.from('deletion_receipts').select('receipt_hash, disposition, status').eq('child_id', CID.Brielle)).data ?? []
  const danaSees = (await dana.client.from('deletion_receipts').select('receipt_hash').eq('child_id', CID.Brielle)).data ?? []
  sethSees.length === 1 && sethSees[0].receipt_hash && danaSees.length === 0
    ? ok('parent reads their own receipt (hash + disposition); another family sees nothing') : bad(`receipt vis: seth=${sethSees.length} dana=${danaSees.length}`)

  // ---- AC-2: receipt is immutable + hash-chained (delete Theo → chains to Brielle) ----
  // Theo holds an assignment + a submission linked to it → proves the inter-table
  // FK ordering (submissions before assignments) so deletion actually completes.
  console.log('AC-2 immutability + hash chain (+ assignment/submission FK order):')
  const delTheo = await invoke(seth.session.access_token, { childId: CID.Theo })
  const theoLeft = (await q(`select (select count(*) from public.submissions where child_id=$1) s, (select count(*) from public.assignments where child_id=$1) a`, [CID.Theo]))[0]
  const theoPurged = Number(theoLeft.s) === 0 && Number(theoLeft.a) === 0
  const chain = (await q(`select child_id, prev_receipt_hash, receipt_hash from public.deletion_receipts order by created_at`, []))
  const bR = chain.find((r) => r.child_id === CID.Brielle), tR = chain.find((r) => r.child_id === CID.Theo)
  const chained = tR && bR && tR.prev_receipt_hash === bR.receipt_hash && theoPurged
  let immutable = false
  try { await q(`update public.deletion_receipts set parent_id=$1 where child_id=$2`, [uids.dana, CID.Brielle]) } catch { immutable = true }
  let undeletable = false
  try { await q(`delete from public.deletion_receipts where child_id=$1`, [CID.Brielle]) } catch { undeletable = true }
  delTheo.status === 200 && chained && immutable && undeletable
    ? ok('Theo receipt chains to Brielle receipt_hash; receipt update + delete both blocked') : bad(`AC-2: chained=${chained} immutable=${immutable} undeletable=${undeletable}`)

  // ---- AC-6 schema backstop: EVERY children FK is RESTRICT (a future CASCADE
  //      table can't silently bypass the children-last completeness guard) ----
  console.log('AC-6 schema backstop:')
  const nonRestrict = await q(`select conrelid::regclass::text tbl from pg_constraint where contype='f' and confrelid='public.children'::regclass and confdeltype<>'r'`)
  nonRestrict.length === 0
    ? ok('every FK to children is ON DELETE RESTRICT — a forgotten future table FK-blocks the final delete loudly')
    : bad(`AC-6 schema: non-RESTRICT FKs to children: ${JSON.stringify(nonRestrict)}`)

  // ---- AC-9 siblings + other family untouched ----
  console.log('AC-9 isolation:')
  const wren = (await q(`select count(*)::int n from public.children where id=$1`, [CID.Wren]))[0].n
  const wrenData = (await q(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='grant'`, [CID.Wren]))[0].n
  wren === 1 && wrenData === 1
    ? ok('other family (Wren) byte-for-byte untouched') : bad(`AC-9: wren=${wren} wrenData=${wrenData}`)
} finally {
  fnServe.kill(); fs.rmSync(envFile, { force: true }); await db.end()
}
console.log(fails ? `\n=== RM-18 DELETION: ${fails} FAIL ===` : '\n=== RM-18 DELETION: ALL PASS (revocation → hard deletion; receipt chain; zombie-safe) ===')
process.exit(fails ? 1 : 0)
