// ============================================================================
// Recorder round-trip test — proves an AttemptEvent round-trips against the
// LOCAL Supabase stack: recordAttempt (contract seam, anon key + fetch, via the
// SECURITY DEFINER record_attempts RPC) writes an attempt row that reads back
// correctly, including the `context` jsonb escape hatch. Plus idempotent replay,
// the contract guard, and the getMastery/getNextActivity seams.
//
// Client path is anon-key + RLS only (recordAttempt). Readback is verified by
// the TEST via a direct local-Postgres query (test-side inspection — not the app
// client), so no service-role/prod key ever lives in a client.
//
// Run (from db/, with the local stack up):
//   eval "$(supabase status -o env)"; node --test scripts/capture-roundtrip.mjs
// ============================================================================
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import pgpkg from 'pg'
import { stackConfig, applySchema } from './local-stack.mjs'
import { recordAttempt, getMastery, getNextActivity, validateAttemptEvent } from '../../contracts/capture.mjs'

const { Client } = pgpkg
const CREDS = { name: 'RoundTrip', pin: '2468' }        // the seeded, consented player
const CHILD_ID = '0a0a0a0a-0000-4000-8000-00000000c0de'  // the seeded child (opaque)
const SESSION = '11112222-3333-4444-8555-666677778888'
let cfg

before(async () => {
  cfg = stackConfig()
  await applySchema(cfg.dbUrl)
  await new Promise((r) => setTimeout(r, 1500)) // let PostgREST reload the schema
})

const uuid = () => crypto.randomUUID()
const makeEvent = (over = {}) => ({
  clientAttemptId: uuid(),
  clientSessionId: SESSION,
  stageIndex: 0, skill: 'addition', result: 'correct',
  problemText: '2 + 3', correctAnswer: 5, chosenAnswer: 5,
  responseMs: 4200, inputMethod: 'voice', asrConfidence: 0.94,
  runTimeS: 12.5, level: 1, mode: 'journey',
  context: { source: 'roundtrip-test', clientVersion: 'm1', extra: 42 },
  ...over,
})
async function db() { const c = new Client({ connectionString: cfg.dbUrl }); await c.connect(); return c }

test('AttemptEvent round-trips: recordAttempt writes, the row reads back correctly', async () => {
  const ev = makeEvent()
  const res = await recordAttempt(cfg, CREDS, ev, { startedAt: new Date().toISOString() })
  assert.deepEqual({ ok: res.ok, inserted: res.inserted, rejected: res.rejected },
                   { ok: true, inserted: 1, rejected: 0 })
  const c = await db()
  try {
    const { rows } = await c.query(
      `select child_id, skill_id, result, problem_text, correct_answer, chosen_answer,
              response_ms, input_method, asr_confidence, standard_code, stage_index, mode, context
         from public.attempts where client_attempt_id = $1`, [ev.clientAttemptId])
    assert.equal(rows.length, 1, 'exactly one attempt row landed')
    const r = rows[0]
    assert.equal(r.child_id, CHILD_ID, 'child_id resolved SERVER-SIDE (never from the client)')
    assert.equal(r.skill_id, 'add5', 'stage_index 0 -> skill add5')
    assert.equal(r.result, 'correct')
    assert.equal(r.problem_text, '2 + 3')
    assert.equal(r.correct_answer, 5)
    assert.equal(r.chosen_answer, 5)
    assert.equal(r.response_ms, 4200)
    assert.equal(r.input_method, 'voice')
    assert.equal(Number(r.asr_confidence), 0.94)
    assert.equal(r.standard_code, 'K.OA.A.5', 'CCSS snapshot stamped server-side')
    assert.equal(r.stage_index, 0)
    assert.equal(r.mode, 'journey')
    assert.deepEqual(r.context, ev.context, 'context escape hatch round-trips verbatim')
  } finally { await c.end() }
})

test('idempotent replay: same clientAttemptId -> inserted 0, duplicates 1, still one row', async () => {
  const ev = makeEvent()
  assert.equal((await recordAttempt(cfg, CREDS, ev)).inserted, 1)
  const replay = await recordAttempt(cfg, CREDS, ev)
  assert.deepEqual({ inserted: replay.inserted, duplicates: replay.duplicates }, { inserted: 0, duplicates: 1 })
  const c = await db()
  try {
    const { rows } = await c.query(`select count(*)::int n from public.attempts where client_attempt_id=$1`, [ev.clientAttemptId])
    assert.equal(rows[0].n, 1, 'replay did not double-write')
  } finally { await c.end() }
})

test('context escape hatch: a fresh, un-migrated signal round-trips through context', async () => {
  const ev = makeEvent({ context: { newSignal: 'hintUsed', count: 3, nested: { ok: true } } })
  const res = await recordAttempt(cfg, CREDS, ev)
  assert.equal(res.inserted, 1)
  const c = await db()
  try {
    const { rows } = await c.query(`select context from public.attempts where client_attempt_id=$1`, [ev.clientAttemptId])
    assert.deepEqual(rows[0].context, ev.context, 'arbitrary new signals persist without a migration')
  } finally { await c.end() }
})

test('contract guard: an invalid event is rejected before any network write', async () => {
  const bad = makeEvent({ stageIndex: 99 })
  assert.ok(validateAttemptEvent(bad).length, 'validator flags the bad stageIndex')
  const res = await recordAttempt(cfg, CREDS, bad)
  assert.deepEqual({ ok: res.ok, error: res.error }, { ok: false, error: 'invalid_event' })
})

test('seams present and honest: getMastery / getNextActivity return empties (no fabricated data)', async () => {
  assert.deepEqual(await getMastery(cfg, { childId: CHILD_ID }), { skills: [] })
  assert.equal(await getNextActivity(cfg, { childId: CHILD_ID }), null)
})
