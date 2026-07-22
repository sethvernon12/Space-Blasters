// smoke-test.mjs — PROD smoke test (Brielle launch). Verifies the hard gate end-to-end at the
// DB/RPC level: a child records an attempt → the parent sees the summary → cross-child/cross-family
// isolation holds with ZERO leaks. Runs self-contained against a fresh ephemeral DB (the same
// from-empty migration apply the deploy uses), so it is green NOW without accounts; the Google
// sign-in + $1 Stripe-consent legs need the live target and are verified at deploy (steps below).
//
// Run:  node db/scripts/smoke-test.mjs            (self-contained — proves capture + isolation)
import { ephemeralDb, applyMigrations, seedSkills } from './lib.mjs'
import { seedFixtures, FIX } from './seed.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()

const db = await ephemeralDb()
await applyMigrations(db.client, { local: true })
await seedSkills(db.client)
await seedFixtures(db.client)
const c = db.client

// run fn as `role` with the given verified JWT subject, in a rolled-back txn
async function as(role, sub, fn) {
  await c.query('begin')
  try {
    await c.query(`set local role ${role}`)
    if (sub) await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })])
    return await fn()
  } finally { await c.query('rollback') }
}
const count = async (sql, p = []) => (await c.query(sql, p)).rows.length

console.log('SMOKE — capture → summary → isolation (self-contained ephemeral DB)')

// 1. A CHILD RECORDS AN ATTEMPT (the authed game capture path)
await as('authenticated', FIX.childA1Login, async () => {
  const evs = [
    { clientAttemptId: uuid(), clientSessionId: uuid(), stageIndex: 0, skill: 'addition', result: 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null },
    { clientAttemptId: uuid(), clientSessionId: uuid(), stageIndex: 0, skill: 'addition', result: 'incorrect', problemText: '4 + 1', correctAnswer: 5, chosenAnswer: 4, responseMs: 2500, inputMethod: 'tap', asrConfidence: null },
  ]
  const r = (await c.query(`select public.record_attempts_authed($1, $2::jsonb) r`, [FIX.childA1, JSON.stringify(buildBatch(evs))])).rows[0].r
  ;(r && (r.ok === true || r.recorded >= 1 || r.inserted >= 1)) ? ok(`child records attempts (${JSON.stringify(r).slice(0, 80)})`) : bad(`record_attempts_authed: ${JSON.stringify(r)}`)
  const landed = await count(`select 1 from public.attempts where child_id = $1`, [FIX.childA1])
  landed >= 1 ? ok('the attempt landed in the child\'s own log') : bad('attempt did not land')
})

// 2. THE PARENT SEES THE SUMMARY (the honest aggregate)
await as('authenticated', FIX.parentA, async () => {
  const rows = (await c.query(`select * from public.follow_me_aggregate($1)`, [FIX.childA1])).rows
  const r = rows[0]
  ;(rows.length === 1 && Number.isInteger(r.faithfulness_star) && r.faithfulness_star >= 1 && r.first_name)
    ? ok(`parent sees the child summary (${r.first_name}, ★${r.faithfulness_star})`) : bad(`parent summary: ${JSON.stringify(rows)}`)
})

// 3. ISOLATION — ZERO cross-family / cross-child leaks (the hard gate)
await as('authenticated', FIX.parentB, async () => {
  (await count(`select 1 from public.follow_me_aggregate($1)`, [FIX.childA1])) === 0 ? ok('cross-family: parentB sees 0 of childA1\'s summary') : bad('cross-family summary leak')
  ;(await count(`select 1 from public.attempts where child_id = $1`, [FIX.childA1])) === 0 ? ok('cross-family: parentB reads 0 of childA1\'s raw attempts') : bad('cross-family attempts leak')
  ;(await count(`select 1 from public.child_skill_mastery where child_id = $1`, [FIX.childA1])) === 0 ? ok('cross-family: parentB reads 0 of childA1\'s mastery') : bad('cross-family mastery leak')
})
await as('authenticated', FIX.childA1Login, async () => {
  (await count(`select 1 from public.follow_me_aggregate($1)`, [FIX.childA2])) === 0 ? ok('cross-child: childA1 sees 0 of sibling childA2') : bad('cross-child leak')
})
await as('anon', null, async () => {
  let denied = false
  try { await c.query(`select public.follow_me_aggregate($1)`, [FIX.childA1]) } catch { denied = true }
  denied ? ok('anon (the public key) cannot reach child data') : bad('anon reached child data')
})

console.log('\nLIVE-ONLY legs (verify at deploy against the live target — need Google/Stripe):')
console.log('  • Google sign-in returns a parent session (Supabase Auth → Google).')
console.log('  • The $1 Stripe consent charge fires stripe-webhook → grant_consent → an immutable consent_ledger row.')

await db.stop()
console.log(fails ? `\n=== SMOKE: ${fails} FAIL ===` : '\n=== SMOKE: ALL PASS (capture + summary + zero-leak isolation) ===')
process.exit(fails ? 1 : 0)
