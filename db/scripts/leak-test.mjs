// ============================================================================
// CROSS-CHILD DATA-LEAK TEST — proves the RLS in 0001_mastery.sql actually
// isolates families and children. Runs ONLY against a local/ephemeral database
// (prod guard in lib.mjs). From Phase 3 on, this suite gates every deploy.
//
// Adversary model exercised here:
//   * parent B probing family A's rows (cross-FAMILY read + write)
//   * child A1's own login probing sibling A2 (cross-CHILD, same family)
//   * the anon role (the public game's key) touching anything at all
//   * any client writing mastery/misconception state (server-only tables)
//   * anyone (incl. service_role) mutating append-only/immutable tables
// ============================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ephemeralDb, applyMigrations, seedSkills } from './lib.mjs';
import { seedFixtures, FIX } from './seed.mjs';

let db;

before(async () => {
  db = await ephemeralDb();
  await applyMigrations(db.client, { local: true });
  await seedSkills(db.client);
  await seedFixtures(db.client);
});

after(async () => { if (db) await db.stop(); });

// Run `fn` inside a rolled-back transaction as `role` with the given verified
// JWT subject (exactly how Supabase presents auth.uid()).
async function as(role, sub, fn) {
  await db.client.query('begin');
  try {
    await db.client.query(`set local role ${role}`);
    if (sub) await db.client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
    return await fn(db.client);
  } finally {
    await db.client.query('rollback');
  }
}

const count = async (c, sql, params = []) => (await c.query(sql, params)).rows.length;

// Assert a statement is rejected, using a savepoint so the surrounding
// transaction survives the (expected) error and later assertions still run.
async function rejects(c, sql, params, re, label) {
  await c.query('savepoint sp');
  let err = null;
  try { await c.query(sql, params); } catch (e) { err = e; }
  await c.query('rollback to savepoint sp');
  assert.ok(err, `expected rejection${label ? ` (${label})` : ''}: ${sql}`);
  assert.match(String(err.message), re, label);
}

// ---------------------------------------------------------------------------
test('parent sees exactly their own children — and no one else’s', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    const rows = (await c.query('select id from public.children order by nickname')).rows.map(r => r.id);
    assert.deepEqual(rows.sort(), [FIX.childA1, FIX.childA2, FIX.childA3].sort());
  });
  await as('authenticated', FIX.parentB, async (c) => {
    const rows = (await c.query('select id from public.children')).rows.map(r => r.id);
    assert.deepEqual(rows, [FIX.childB1]);
  });
});

test('child profiles and consent rows are SERVICE-ONLY writes (no client forgery)', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    // a client can never create a child profile (consent flow does it server-side)
    await rejects(c, `insert into public.children (parent_id, nickname) values ($1, 'Forged')`,
      [FIX.parentA], /permission denied/i, 'client insert children');
    // ...and can never write its own "verifiable parental consent" record
    await rejects(c, `insert into public.consent_ledger (parent_id, child_id, action, method, policy_version)
         values ($1, $2, 'grant', 'stripe_card_transaction', 'forged')`,
      [FIX.parentA, FIX.childA1], /permission denied/i, 'client insert consent');
  });
});

test('client updates on children are limited to cosmetic columns', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    const upd = await c.query(`update public.children set nickname = 'Nova2' where id = $1`, [FIX.childA1]);
    assert.equal(upd.rowCount, 1, 'nickname update allowed for own child');
    await rejects(c, `update public.children set auth_user_id = $1 where id = $2`,
      [FIX.parentA, FIX.childA1], /permission denied/i, 'auth_user_id locked');
    await rejects(c, `update public.children set legacy_player_id = null where id = $1`,
      [FIX.childA1], /permission denied/i, 'legacy claim column locked');
    await rejects(c, `update public.children set consent_id = null where id = $1`,
      [FIX.childA1], /permission denied/i, 'consent link locked');
    await rejects(c, `update public.children set parent_id = $1 where id = $2`,
      [FIX.parentB, FIX.childA1], /permission denied/i, 're-parenting locked');
  });
});

// (the consent gate itself is exercised through the RPC below — direct client
//  inserts are refused wholesale by the one-write-path test above)

test('cross-FAMILY reads return zero rows on every child-scoped table', async () => {
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.children where id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.attempts where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.child_skill_mastery where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.child_skill_misconception where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.consent_ledger where child_id = $1', [FIX.childA1]), 0);
  });
});

test('attempts have ONE write path: every direct client insert is refused', async () => {
  // Phase 2: the record_attempts RPC is the sole writer (it alone couples the
  // event log to the mastery projection). Direct writes — even for your OWN
  // child — are gone entirely (no grant), so cross-family writes are moot too.
  for (const [sub, child] of [[FIX.parentA, FIX.childA1], [FIX.parentB, FIX.childA1], [FIX.childA1Login, FIX.childA1]]) {
    await as('authenticated', sub, async (c) => {
      await rejects(c, `insert into public.attempts (child_id, skill_id, client_attempt_id, result)
           values ($1, 'add5', gen_random_uuid(), 'correct')`, [child], /permission denied/i);
    });
  }
});

test('cross-CHILD, same family: a child login sees ONLY itself, not its sibling', async () => {
  await as('authenticated', FIX.childA1Login, async (c) => {
    const rows = (await c.query('select id from public.children')).rows.map(r => r.id);
    assert.deepEqual(rows, [FIX.childA1]);                     // sibling A2 invisible
    assert.equal(await count(c, 'select 1 from public.attempts where child_id = $1', [FIX.childA2]), 0);
    assert.equal(await count(c, 'select 1 from public.sessions where child_id = $1', [FIX.childA2]), 0);
  });
});

test('anon (the public game key) can touch nothing', async () => {
  for (const t of ['children', 'attempts', 'child_skill_mastery', 'child_skill_misconception',
                   'consent_ledger', 'skills', 'sessions', 'tutor_grants', 'rpc_rate_limits']) {
    await as('anon', null, async (c) => {
      await rejects(c, `select * from public.${t} limit 1`, undefined, /permission denied/i, `anon read ${t}`);
    });
  }
  await as('anon', null, async (c) => {
    await rejects(c, `insert into public.attempts (child_id, skill_id, client_attempt_id, result)
         values ($1, 'add5', gen_random_uuid(), 'correct')`, [FIX.childA1], /permission denied/i);
  });
});

test('mastery & misconception state are read-only to ALL clients (service-only writers)', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    // no INSERT/UPDATE/DELETE grant at all -> permission denied even for the owner
    await rejects(c, `insert into public.child_skill_mastery (child_id, skill_id, model_version)
         values ($1, 'add5', 'x')`, [FIX.childA1], /permission denied/i);
    await rejects(c, `update public.child_skill_mastery set alpha = 999 where child_id = $1`, [FIX.childA1], /permission denied/i);
    await rejects(c, `delete from public.child_skill_misconception where child_id = $1`, [FIX.childA1], /permission denied/i);
  });
});

test('attempts are append-only and consent_ledger immutable — even for service_role', async () => {
  await as('service_role', null, async (c) => {
    await rejects(c, `update public.attempts set result = 'correct' where result = 'incorrect'`, undefined, /append-only|immutable/i);
    await rejects(c, `delete from public.attempts`, undefined, /append-only|immutable/i);
    await rejects(c, `update public.consent_ledger set action = 'revoke'`, undefined, /append-only|immutable/i);
    await rejects(c, `delete from public.consent_ledger`, undefined, /append-only|immutable/i);
  });
});

test('unclaimed legacy children (Phase-3 placeholder) are invisible to every client', async () => {
  for (const sub of [FIX.parentA, FIX.parentB, FIX.childA1Login]) {
    await as('authenticated', sub, async (c) => {
      assert.equal(await count(c, 'select 1 from public.children where id = $1', [FIX.legacyChild]), 0);
    });
  }
});

test('service_role bypasses RLS (sanity — this is WHY Edge Functions must re-filter by child_id)', async () => {
  await as('service_role', null, async (c) => {
    const n = (await c.query('select count(*)::int as n from public.children')).rows[0].n;
    assert.equal(n, 5); // sees all children incl. the unclaimed legacy one
  });
});

// ---------------------------------------------------------------------------
// record_attempts RPC — the interim-keyed (name+PIN) atomic write path
// ---------------------------------------------------------------------------
const SESSION = () => ({
  client_session_id: crypto.randomUUID(),
  mode: 'journey',
  started_at: new Date().toISOString(),
});
const ATT = (over = {}) => ({
  client_attempt_id: crypto.randomUUID(),
  stage_index: 0, skill: 'addition', result: 'correct',
  problem_text: '2 + 3', correct_answer: 5, chosen_answer: 5,
  response_ms: 4100, input_method: 'voice', asr_confidence: 0.9,
  run_time_s: 12.3, level: 1, ...over,
});
const callRpc = async (c, name, pin, batch) =>
  (await c.query(`select public.record_attempts($1, $2, $3::jsonb) as r`, [name, pin, JSON.stringify(batch)])).rows[0].r;

test('RPC happy path: atomic insert + mastery + session; replay is a no-op (idempotent)', async () => {
  await as('anon', null, async (c) => {
    // use make10 (stage 4) — no seeded fixture rows for it, so expectations are exact
    const M = { stage_index: 4, skill: 'make-ten', problem_text: '3 + 7', correct_answer: 10, chosen_answer: 10 };
    const batch = { ...SESSION(), attempts: [
      ATT(M), ATT({ ...M, result: 'incorrect', chosen_answer: 9 }), ATT({ ...M, result: 'invalid' })] };
    const r1 = await callRpc(c, 'NovaPilot', FIX.pinNova, batch);
    assert.deepEqual({ ok: r1.ok, inserted: r1.inserted, duplicates: r1.duplicates, rejected: r1.rejected },
                     { ok: true, inserted: 3, duplicates: 0, rejected: 0 });
    // exact same batch again (offline replay / multi-device flush)
    const r2 = await callRpc(c, 'NovaPilot', FIX.pinNova, batch);
    assert.deepEqual({ inserted: r2.inserted, duplicates: r2.duplicates }, { inserted: 0, duplicates: 3 });
    // switch to service view INSIDE the same tx to inspect what was written
    await c.query(`set local role service_role`);
    const att = await c.query(
      `select result, standard_code from public.attempts
        where child_id = $1 and skill_id = 'make10'`, [FIX.childA1]);
    assert.equal(att.rows.length, 3, 'exactly 3 rows despite replay');
    assert.ok(att.rows.every(r => r.standard_code === 'K.OA.A.4'), 'CCSS snapshot stamped');
    const m = (await c.query(
      `select alpha, beta, attempts_count, correct_count from public.child_skill_mastery
        where child_id = $1 and skill_id = 'make10'`, [FIX.childA1])).rows[0];
    // 1 correct + 1 incorrect counted; 'invalid' logged but NEVER counted
    // (decay over the ~0s between the two events is ~1, so alpha≈2, beta=2)
    assert.ok(Math.abs(m.alpha - 2) < 1e-6 && Math.abs(m.beta - 2) < 1e-6, `alpha/beta ≈ 2/2, got ${m.alpha}/${m.beta}`);
    assert.deepEqual({ n: m.attempts_count, cc: m.correct_count }, { n: 2, cc: 1 });
    const s = (await c.query(
      `select attempts_count, correct_count from public.sessions where client_session_id = $1`,
      [batch.client_session_id])).rows[0];
    assert.deepEqual({ n: s.attempts_count, cc: s.correct_count }, { n: 2, cc: 1 });
  });
});

test('RPC auth: wrong PIN -> generic denied, 5 strikes -> locked even for the right PIN', async () => {
  await as('anon', null, async (c) => {
    // malformed PINs are bad_request (client bug), not an auth strike
    for (const badFormat of ['abcd', '12345', '12 4', '']) {
      const r = await callRpc(c, 'NovaPilot', badFormat, { ...SESSION(), attempts: [] });
      assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'bad_request' });
    }
    // name matching is case-insensitive + trimmed (mirrors signup_or_login):
    // a valid child must never be rejected on a name-case/whitespace mismatch
    const okName = await callRpc(c, '  novapilot ', FIX.pinNova, { ...SESSION(), attempts: [] });
    assert.equal(okName.ok, true, 'trimmed, case-insensitive name resolves');
    for (let i = 0; i < 5; i++) {
      const r = await callRpc(c, 'NovaPilot', '0000', { ...SESSION(), attempts: [] });
      assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'denied' }, 'no PIN oracle');
    }
    const locked = await callRpc(c, 'NovaPilot', FIX.pinNova, { ...SESSION(), attempts: [ATT()] });
    assert.deepEqual({ ok: locked.ok, error: locked.error }, { ok: false, error: 'rate_limited' });
    await c.query(`set local role service_role`);
    // RPC-written rows always carry a session; seeded fixtures don't — so this
    // isolates "rows written during THIS test" (each test tx rolls back anyway)
    assert.equal(await count(c, `select 1 from public.attempts where child_id = $1 and session_id is not null`, [FIX.childA1]), 0,
      'zero rows written during a brute-force run');
  });
});

test('RPC consent gate: a consent-less legacy child is refused, zero rows', async () => {
  await as('anon', null, async (c) => {
    const r = await callRpc(c, 'LegacyKid', FIX.pinLegacy, { ...SESSION(), attempts: [ATT()] });
    assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'no_consent' });
    await c.query(`set local role service_role`);
    assert.equal(await count(c, `select 1 from public.attempts where child_id = $1`, [FIX.legacyChild]), 0);
    assert.equal(await count(c, `select 1 from public.sessions where child_id = $1`, [FIX.legacyChild]), 0);
  });
});

test('RPC forgery: client-supplied child ids are ignored; bad stages/skills rejected', async () => {
  await as('anon', null, async (c) => {
    const batch = { ...SESSION(), child_id: FIX.childB1,       // forged top-level child id
      attempts: [
        { ...ATT(), child_id: FIX.childB1 },                   // forged per-attempt child id
        ATT({ stage_index: 999 }),                             // unknown stage
        ATT({ skill: 'division', stage_index: 0 }),            // tag/stage mismatch
        ATT({ result: 'misconception' }),                      // derived label — client may not bake it
      ] };
    const r = await callRpc(c, 'NovaPilot', FIX.pinNova, batch);
    assert.deepEqual({ inserted: r.inserted, rejected: r.rejected }, { inserted: 1, rejected: 3 });
    await c.query(`set local role service_role`);
    // the one inserted row landed on the SERVER-resolved child, not the forged one
    // (session_id filter isolates RPC-written rows from seeded fixtures)
    assert.equal(await count(c, `select 1 from public.attempts where child_id = $1 and session_id is not null`, [FIX.childB1]), 0);
    assert.equal(await count(c, `select 1 from public.attempts where child_id = $1 and session_id is not null`, [FIX.childA1]), 1);
  });
});

test('RPC rate cap: >6 calls in a minute for one name are refused', async () => {
  await as('anon', null, async (c) => {
    let refused = 0;
    for (let i = 0; i < 8; i++) {
      const r = await callRpc(c, 'NovaPilot', FIX.pinNova, { ...SESSION(), attempts: [] });
      if (!r.ok && r.error === 'rate_limited') refused++;
    }
    assert.equal(refused, 2, 'calls 7 and 8 hit the per-minute cap');
  });
});

// ---------------------------------------------------------------------------
// tutor scoping + sessions read scope
// ---------------------------------------------------------------------------
test('tutor scope: granted child only, read-only, and revocation cuts access', async () => {
  await as('authenticated', FIX.tutor, async (c) => {
    const kids = (await c.query('select id from public.children')).rows.map(r => r.id);
    assert.deepEqual(kids, [FIX.childA1], 'tutor sees ONLY the granted child');
    assert.ok(await count(c, 'select 1 from public.child_skill_mastery where child_id = $1', [FIX.childA1]) > 0);
    assert.ok(await count(c, 'select 1 from public.sessions where child_id = $1', [FIX.childA1]) > 0);
    assert.equal(await count(c, 'select 1 from public.attempts where child_id = $1', [FIX.childA2]), 0);
    assert.equal(await count(c, 'select 1 from public.consent_ledger'), 0, 'consent ledger is parent-only');
    // children_update policy matches no rows for a tutor -> silent 0-row no-op
    const upd = await c.query(`update public.children set nickname = 'hax' where id = $1`, [FIX.childA1]);
    assert.equal(upd.rowCount, 0, 'tutor cannot modify the child');
    await rejects(c, `insert into public.attempts (child_id, skill_id, client_attempt_id, result)
         values ($1, 'add5', gen_random_uuid(), 'correct')`, [FIX.childA1], /permission denied/i);
    // re-scoping a grant to another child is blocked at the COLUMN level
    await rejects(c, `update public.tutor_grants set child_id = $1 where tutor_id = $2`,
      [FIX.childA2, FIX.tutor], /permission denied/i, 'tutor cannot re-scope own grant');
  });
  // parent revokes -> tutor loses everything (same tx: revoke as parent, read as tutor)
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`update public.tutor_grants set active = false, revoked_at = now() where tutor_id = $1`, [FIX.tutor]);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: FIX.tutor })]);
    assert.equal(await count(c, 'select 1 from public.children'), 0, 'revoked tutor sees nothing');
    assert.equal(await count(c, 'select 1 from public.child_skill_mastery'), 0);
  });
});

test('sessions: parents see own children’s sessions only; no client writes', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    assert.ok(await count(c, 'select 1 from public.sessions where child_id = $1', [FIX.childA1]) > 0);
    await rejects(c, `insert into public.sessions (child_id, client_session_id, started_at)
         values ($1, gen_random_uuid(), now())`, [FIX.childA1], /permission denied/i);
    await rejects(c, `update public.sessions set attempts_count = 99 where child_id = $1`, [FIX.childA1], /permission denied/i);
  });
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.sessions where child_id = $1', [FIX.childA1]), 0);
  });
});

test('skills taxonomy is readable by signed-in users and write-protected', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    const n = (await c.query('select count(*)::int as n from public.skills')).rows[0].n;
    assert.ok(n >= 23, 'expected the full 23-stage taxonomy');
    await rejects(c, `update public.skills set display_name = 'hacked' where id = 'add5'`, undefined, /permission denied/i);
  });
});

// Phase 5 · 5a: the grade-job spine tables are child-scoped like everything else.
test('grading tables (5a): rows exist but cross-family reads zero; ledger is service-only', async () => {
  // seed (committed, as owner/superuser) a grade job + proposal + ledger for child A1
  const up = (await db.client.query(
    `insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
     values ($1::uuid,$1::uuid,'parent',$2,'image/jpeg',1,true,'inbox') returning id`, [FIX.childA1, `${FIX.childA1}/leak.jpg`])).rows[0].id;
  const job = (await db.client.query(
    `insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, client_job_id)
     values ($1,$2,'mult2','{}'::jsonb, gen_random_uuid()) returning id`, [FIX.childA1, up])).rows[0].id;
  await db.client.query(
    `insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, provider)
     values ($1,$2,$3,'mult2',42,'mock')`, [job, FIX.childA1, up]);
  await db.client.query(`insert into public.grade_cost_ledger (child_id, reserved) values ($1, 1)`, [FIX.childA1]);

  // the rows really exist (queried as the table owner — proves the zero below is isolation, not emptiness)
  assert.equal((await db.client.query('select count(*)::int n from public.uploads where child_id = $1', [FIX.childA1])).rows[0].n, 1);
  assert.equal((await db.client.query('select count(*)::int n from public.grade_jobs where child_id = $1', [FIX.childA1])).rows[0].n, 1);
  assert.equal((await db.client.query('select count(*)::int n from public.grade_proposals where child_id = $1', [FIX.childA1])).rows[0].n, 1);
  // POSITIVE control: the consented parent CAN see their own child's upload (so the cross-family
  // zeros below are proven isolation, not an empty table) — and STILL cannot write it (RPC-only path)
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal(await count(c, 'select 1 from public.uploads where child_id = $1', [FIX.childA1]), 1, 'consented parent reads own child upload');
    await rejects(c, `insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
         values ($1,$1,'parent',$2,'image/jpeg',1,true,'inbox')`, [FIX.childA1, `${FIX.childA1}/forge.jpg`], /permission denied/i, 'client insert upload');
    await rejects(c, `update public.uploads set status = 'graded' where child_id = $1`, [FIX.childA1], /permission denied/i, 'client update upload');
    await rejects(c, `delete from public.uploads where child_id = $1`, [FIX.childA1], /permission denied/i, 'client delete upload');
  });
  // cross-FAMILY: parent B sees zero grade rows AND zero uploads (photos of A1's work); ledger has no client grant
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.uploads where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.grade_jobs where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.grade_proposals where child_id = $1', [FIX.childA1]), 0);
    await rejects(c, 'select 1 from public.grade_cost_ledger where child_id = $1', [FIX.childA1], /permission denied/i);
  });
  // cross-CHILD, same family: sibling A2's login sees none of A1's grade rows
  await as('authenticated', FIX.childA1Login, async (c) => {
    assert.equal(await count(c, 'select 1 from public.grade_jobs where child_id = $1', [FIX.childA2]), 0);
    assert.equal(await count(c, 'select 1 from public.grade_proposals where child_id = $1', [FIX.childA2]), 0);
    // SAF (0031): the SUBJECT child sees none of its OWN pending proposals/jobs either —
    // unconfirmed AI grades never reach the child (only the moderated sent-to-child artifact does)
    assert.equal(await count(c, 'select 1 from public.grade_jobs where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.grade_proposals where child_id = $1', [FIX.childA1]), 0);
  });
});

// Phase 5 · Slice 2 (C-obs2): REALTIME CHANNEL ISOLATION. The hub subscribes to Postgres
// Changes on grade_proposals (GradeReview.tsx) — the ONLY table in the supabase_realtime
// publication. Realtime delivers a change to a subscriber ONLY if that subscriber can SELECT
// the row under RLS; the client-side channel `filter` (child_id=eq.X) is NOT a security
// boundary (a malicious client can subscribe filtered to any child). So live-subscription
// isolation reduces to two invariants, both asserted here (the live-stack end-to-end
// subscription proof is rm43-realtime-isolation-e2e.mjs):
//   (1) every live-streamed table FORCES RLS — nothing streams unguarded; and
//   (2) grade_proposals' per-subscriber RLS denies the subject child (SAF), a sibling, and
//       another family, while a reviewer (parent/tutor) IS delivered the row.
test('Realtime channel isolation (C-obs2): only RLS-forced tables stream, and only a reviewer receives a child’s live grade_proposals', async () => {
  // (1) publication invariant — every table that streams live changes forces RLS
  const pub = (await db.client.query(`
    select t.schemaname, t.tablename, c.relrowsecurity, c.relforcerowsecurity
      from pg_publication_tables t
      join pg_namespace n on n.nspname = t.schemaname
      join pg_class c on c.relname = t.tablename and c.relnamespace = n.oid
     where t.pubname = 'supabase_realtime'`)).rows;
  assert.ok(pub.some((r) => r.schemaname === 'public' && r.tablename === 'grade_proposals'),
    'grade_proposals is in supabase_realtime (the probe is live)');
  for (const r of pub) {
    assert.ok(r.relrowsecurity && r.relforcerowsecurity,
      `live-streamed table ${r.schemaname}.${r.tablename} must FORCE RLS (no table streams changes without per-subscriber RLS)`);
  }
  // FORCE RLS only guarantees the policy APPLIES — not that it is restrictive. A published
  // table with a permissive USING(true) authenticated/public SELECT policy would pass the
  // flags check yet fan every row out to every subscriber, so reject that too.
  const permissive = (await db.client.query(`
    select p.schemaname, p.tablename, p.policyname
      from pg_policies p
      join pg_publication_tables t on t.schemaname = p.schemaname and t.tablename = p.tablename
     where t.pubname = 'supabase_realtime' and p.cmd in ('SELECT', 'ALL')
       and ('authenticated' = any(p.roles) or 'public' = any(p.roles))
       and coalesce(p.qual, 'true') = 'true'`)).rows;
  assert.equal(permissive.length, 0,
    `a live-streamed table has a permissive USING(true) SELECT policy — would fan out cross-family: ${JSON.stringify(permissive)}`);

  // (2) delivery isolation — seed a proposal for child A1, then check per-subscriber SELECT
  const up = (await db.client.query(
    `insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
     values ($1::uuid,$1::uuid,'parent',$2,'image/jpeg',1,true,'inbox') returning id`, [FIX.childA1, `${FIX.childA1}/rt.jpg`])).rows[0].id;
  const job = (await db.client.query(
    `insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, client_job_id)
     values ($1,$2,'mult2','{}'::jsonb, gen_random_uuid()) returning id`, [FIX.childA1, up])).rows[0].id;
  await db.client.query(
    `insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, provider)
     values ($1,$2,$3,'mult2',42,'mock')`, [job, FIX.childA1, up]);

  // POSITIVE: a reviewer (parent A) WOULD be delivered A1's live proposal(s) (so the zeros are
  // isolation, not an empty table). >=1 because earlier tests also commit A1 proposals.
  await as('authenticated', FIX.parentA, async (c) => {
    assert.ok(await count(c, 'select 1 from public.grade_proposals where child_id = $1', [FIX.childA1]) >= 1,
      'reviewer parent is delivered own child’s proposal');
  });
  // SUBJECT child (SAF) + cross-CHILD: A1's own subscription receives NOTHING about itself or a sibling
  await as('authenticated', FIX.childA1Login, async (c) => {
    assert.equal(await count(c, 'select 1 from public.grade_proposals where child_id = $1', [FIX.childA1]), 0,
      'subject child receives none of its own live proposals');
    assert.equal(await count(c, 'select 1 from public.grade_proposals where child_id = $1', [FIX.childA2]), 0,
      'child cannot receive a sibling’s live proposals');
  });
  // cross-FAMILY: parent B is delivered NOTHING about A1, even subscribing filtered to A1's id
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.grade_proposals where child_id = $1', [FIX.childA1]), 0,
      'another family receives nothing, regardless of the channel filter');
  });
});

// Phase 5 · Slice 3 (D-LOW1): the adult-keyed helper functions must not let one signed-in
// adult probe ANOTHER adult's standing/subject/churn/deletion. The definer-only helpers are
// revoked from `authenticated` (0036); actor_is_deleted (needed by the zombie-write RLS
// policies) is pinned to the caller so a cross-uid probe reveals nothing.
test('adult-keyed helpers do not leak another adult’s standing (D-LOW1)', async () => {
  // a "deleted actor": a deletion receipt carrying a known child_auth_user_id. Use a NEUTRAL
  // parent_id (not a fixture parent) so this seed can't perturb any parent-scoped count in
  // another test — actor_is_deleted keys only on child_auth_user_id.
  const deletedUid = '0000dead-0000-4000-8000-000000000001';
  const neutralParent = '0000beef-0000-4000-8000-000000000001';
  await db.client.query(
    `insert into public.deletion_receipts (child_id, parent_id, child_auth_user_id, deleting_actor, disposition, receipt_hash)
     values (gen_random_uuid(), $1, $2, $1, '{}'::jsonb, 'dlow1-hash')`, [neutralParent, deletedUid]);

  // an authenticated adult (parent B) cannot call the definer-only helpers AT ALL — a
  // cross-parent probe of family A returns nothing (permission denied), not a value.
  await as('authenticated', FIX.parentB, async (c) => {
    await rejects(c, `select public.family_muted($1)`, [FIX.parentA], /permission denied/i, 'family_muted');
    await rejects(c, `select public.family_of($1)`, [FIX.parentA], /permission denied/i, 'family_of');
    await rejects(c, `select public.family_child_deletes_30d($1)`, [FIX.parentA], /permission denied/i, 'family_child_deletes_30d');
    await rejects(c, `select public.stable_subject($1)`, [FIX.parentA], /permission denied/i, 'stable_subject');
    // actor_is_deleted stays callable (the RLS zombie-guard needs it) but a CROSS-uid probe
    // reveals nothing — parent B learns nothing about the deleted actor.
    assert.equal((await c.query(`select public.actor_is_deleted($1) d`, [deletedUid])).rows[0].d, false,
      'cross-actor deletion probe returns false (pinned)');
  });
  // the pin still reports the CALLER's OWN deletion status, so the zombie-write guard fires
  await as('authenticated', deletedUid, async (c) => {
    assert.equal((await c.query(`select public.actor_is_deleted($1) d`, [deletedUid])).rows[0].d, true,
      'own deletion tombstone is still reported to self');
  });
});

// Phase 5 · Slice 3b: is_child_actor(uuid) was a cross-family child-existence oracle. It is
// now REVOKED from authenticated; the SEC-REV-13 belt in teaching_artifacts_insert uses the
// param-less is_child_actor_self() instead (behavior-preservation proven end-to-end by rm08).
test('is_child_actor oracle closed; self-check preserved (D-LOW1 sibling)', async () => {
  await as('authenticated', FIX.parentB, async (c) => {
    await rejects(c, `select public.is_child_actor($1)`, [FIX.childA1Login], /permission denied/i, 'is_child_actor(uuid) no longer client-callable');
    assert.equal((await c.query(`select public.is_child_actor_self() s`)).rows[0].s, false, 'adult self → false');
  });
  await as('authenticated', FIX.childA1Login, async (c) => {
    assert.equal((await c.query(`select public.is_child_actor_self() s`)).rows[0].s, true, 'child self → true (drives the SEC-REV-13 belt)');
  });
  // the SERVICE-ROLE adult-gate still rejects a child parent-of-record after the revoke:
  // register_child is SECURITY DEFINER and calls is_child_actor(p_parent_id) as OWNER (which
  // keeps EXECUTE; the revoke is `from authenticated` only). Direct coverage of the null-auth.uid
  // gate — rm11-mint-test.mjs is pre-existing syntax-broken (duplicate `const admin`, since 3.5b).
  const reg = (await db.client.query(`select public.register_child($1, gen_random_uuid(), 'x', 'K') r`, [FIX.childA1Login])).rows[0].r;
  assert.equal(reg.error, 'not_authorized', 'register_child rejects a child parent-of-record (service-role adult-gate intact post-revoke)');
});

// ACCEPTED LOW-RISK ORACLE (documented: docs/BACKLOG.md SEC-REV-28; ties SEC-REV-L12). The
// roster (memberships/channel_members, 0007) and child-self (children_select, 0006) policies
// LEGITIMATELY gate on consent WITHOUT can_view_child, and has_active_consent is security-
// definer to avoid children RLS recursion (0006:32). The residual: an authenticated adult can
// read another child's single consent boolean (needs an unguessable v4 child uuid). This test
// PINS that accepted behavior so a future scoping change trips here for a conscious decision
// (revisit at the pre-scale gate / if the multi-family roster model changes).
test('ACCEPTED: has_active_consent is an intentional unscoped consent predicate (D-LOW1 sibling, SEC-REV-28)', async () => {
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal((await c.query(`select public.has_active_consent($1) h`, [FIX.childA1])).rows[0].h, true,
      'unscoped by design (roster/child-self need it); tracked as SEC-REV-28 — a future scoping change trips this test');
  });
});

// Phase 5 · B-F1 (KER-2): record_grade_proposal re-verifies the SUBJECT CHILD's consent at
// RECORD time, before any write — a proposal cannot be recorded for a consent-revoked child
// even though the job was created while consent was valid (consent is never inherited from the
// job's creation-time check). Fail-closed with NO side effects.
test('B-F1: record_grade_proposal re-checks consent at write time (fail-closed, no side effects)', async () => {
  const seedClaimedJob = async (childId, tag) => {
    const up = (await db.client.query(
      `insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, exif_stripped, status)
       values ($1,$1,'parent',$2,'image/jpeg',1,true,'inbox') returning id`, [childId, `${childId}/${tag}.jpg`])).rows[0].id;
    return (await db.client.query(
      `insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, client_job_id, status)
       values ($1,$2,'mult2','{}'::jsonb, gen_random_uuid(), 'claimed') returning id`, [childId, up])).rows[0].id;
  };
  const REC = `select public.record_grade_proposal($1, 42, 0.9, 'fb', null, 'm', 'mock', 0, 1) r`;

  // POSITIVE: a CONSENTED child (A1) records exactly as before — proposal + job → 'proposed'
  const jobOk = await seedClaimedJob(FIX.childA1, 'bf1ok');
  const recOk = (await db.client.query(REC, [jobOk])).rows[0].r;
  assert.equal(recOk.ok, true, 'consented child: proposal recorded');
  assert.equal((await db.client.query(`select status from public.grade_jobs where id=$1`, [jobOk])).rows[0].status, 'proposed', 'job → proposed');
  assert.equal((await db.client.query(`select count(*)::int n from public.grade_proposals where job_id=$1`, [jobOk])).rows[0].n, 1, 'proposal row recorded');

  // NEGATIVE: a consent-revoked child (A3 has NO consent row) → no_consent, and NO side effects
  const jobNo = await seedClaimedJob(FIX.childA3, 'bf1no');
  const recNo = (await db.client.query(REC, [jobNo])).rows[0].r;
  assert.equal(recNo.ok, false, 'no-consent child: refused');
  assert.equal(recNo.error, 'no_consent', 'error is no_consent');
  assert.equal((await db.client.query(`select status from public.grade_jobs where id=$1`, [jobNo])).rows[0].status, 'claimed', 'job NOT flipped (no side effect)');
  assert.equal((await db.client.query(`select count(*)::int n from public.grade_proposals where job_id=$1`, [jobNo])).rows[0].n, 0, 'no proposal recorded (no side effect)');
});

// ============================================================================
// GROUP ENGINE · S0 — the FALSIFICATION GATE. Extends the isolation matrix to the
// group graph (0007/0008) and proves red-or-green the load-bearing facts the
// group-engine build rests on. Seeds are owner-committed via db.client; probes run
// as the authenticated role under RLS.
// ============================================================================

// S0 · fact (a): the group graph is cross-family isolated, AND membership is a
// SEPARATE axis from child-DATA disclosure — a co-member without a tutor_grant is
// is_group_member=true yet reads ZERO of the child's data (can_view_child ignores memberships).
test('S0(a): group graph cross-family isolated; membership is NOT child-data disclosure', async () => {
  const g = (await db.client.query(`insert into public.groups (purpose, name, created_by) values ('class','S0 Class',$1) returning id`, [FIX.parentA])).rows[0].id;
  await db.client.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true)`, [g, FIX.childA1]);
  const ch = (await db.client.query(`insert into public.channels (group_id, kind, name) values ($1,'thread','General') returning id`, [g])).rows[0].id;
  await db.client.query(`insert into public.channel_members (channel_id, member_child_id, is_guardian_comember) values ($1,$2,false)`, [ch, FIX.childA1]);
  await db.client.query(`insert into public.channel_members (channel_id, member_actor_id, is_guardian_comember) values ($1,$2,true)`, [ch, FIX.parentA]);
  await db.client.query(`insert into public.events (kind, author_actor_id, group_id, payload) values ('schedule',$1,$2,'{}'::jsonb)`, [FIX.parentA, g]);

  // POSITIVE: the owner/guardian reads the group graph
  await as('authenticated', FIX.parentA, async (c) => {
    assert.ok(await count(c, 'select 1 from public.groups where id=$1', [g]) >= 1, 'owner reads own group');
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1', [g]) >= 1, 'owner reads roster');
    assert.ok(await count(c, 'select 1 from public.events where group_id=$1', [g]) >= 1, 'owner reads group events');
  });
  // CROSS-FAMILY: a NON-member (parent B) reads ZERO across the group graph
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.groups where id=$1', [g]), 0, 'non-member: 0 groups');
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1', [g]), 0, 'non-member: 0 memberships');
    assert.equal(await count(c, 'select 1 from public.channels where group_id=$1', [g]), 0, 'non-member: 0 channels');
    assert.equal(await count(c, 'select 1 from public.channel_members where channel_id=$1', [ch]), 0, 'non-member: 0 channel_members');
    assert.equal(await count(c, 'select 1 from public.events where group_id=$1', [g]), 0, 'non-member: 0 group events');
  });
  // anon (the public game key) can never touch ANY table in the group graph
  await as('anon', null, async (c) => {
    for (const t of ['groups', 'memberships', 'channels', 'channel_members', 'events', 'derivation_outbox', 'derivation_rules']) {
      await rejects(c, `select 1 from public.${t} limit 1`, undefined, /permission denied/i, `anon ${t}`);
    }
  });
  // FACT (a): add parent B as a cross-family ADULT co-member → is_group_member=true, but
  // membership confers ZERO child-DATA access (no tutor_grant → can_view_child(childA1)=false).
  await db.client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'member',true)`, [g, FIX.parentB]);
  await as('authenticated', FIX.parentB, async (c) => {
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1', [g]) >= 1, 'co-member now reads the roster (really a member)');
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'co-member WITHOUT a grant: can_view_child = false');
    // membership ≠ disclosure: the co-member reads ZERO of the child's data across EVERY child-DATA table
    // (attempts + child_skill_mastery are non-vacuous — childA1 has seeded rows; a can_view_child
    //  membership-branch regression would flip these from 0 to nonzero and fail here).
    for (const t of ['attempts', 'sessions', 'child_skill_mastery', 'child_skill_misconception', 'assignments', 'submissions', 'teaching_artifacts', 'uploads', 'grade_jobs', 'grade_proposals']) {
      assert.equal(await count(c, `select 1 from public.${t} where child_id=$1`, [FIX.childA1]), 0, `co-member reads 0 of the child’s ${t}`);
    }
  });
});

// S0 · fact (b): tutor_grants cannot yet carry a provenance-distinct, group-scoped
// grant without collision — UNIQUE(tutor_id, child_id) blocks a second (group_derived)
// grant alongside a parent_direct one → the S5a migration is NEEDED (surfaced now).
test('S0(b): tutor_grants UNIQUE(tutor_id,child_id) blocks a provenance-distinct grant → S5a needed', async () => {
  const tutorX = '0000f00d-0000-4000-8000-000000000001';
  // grant #1 = a parent_direct grant (granted_by = the child's own parent A)
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, [tutorX, FIX.childA1, FIX.parentA]);
  // grant #2 = a PROVENANCE-DISTINCT (e.g. group_derived) grant for the SAME tutor+child, granted_by
  // a different actor — it STILL collides under today's UNIQUE(tutor_id, child_id): the schema has no
  // room for two distinct-origin grants on one pair. This is the S5a signal.
  await assert.rejects(
    db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, [tutorX, FIX.childA1, FIX.parentB]),
    /duplicate key|unique/i,
    'a provenance-distinct grant for the same tutor+child collides on UNIQUE(tutor_id,child_id) — S5a must add origin + origin_group_id, move the uniqueness key, and ref-count');
  await db.client.query(`delete from public.tutor_grants where tutor_id=$1`, [tutorX]); // cleanup the throwaway
});

// S0 · fact (c): purge_child cascades EVERY child-keyed group table + tutor_grants,
// with per-table zero residual and the receipt disposition buckets each one.
test('S0(c): purge_child cascades every group table + grants (zero residual + receipt buckets)', async () => {
  const np = '0000ca11-0000-4000-8000-000000000001';                 // neutral parent (no fixture perturbation)
  const kid = '0000ca11-0000-4000-8000-0000000000c1';
  const kau = '0000ca11-0000-4000-8000-0000000000a1';
  await db.client.query(`insert into public.children (id, parent_id, auth_user_id, nickname, grade_band) values ($1,$2,$3,'S0Kid','K')`, [kid, np, kau]);
  const g = (await db.client.query(`insert into public.groups (purpose, name, created_by) values ('class','S0 Purge',$1) returning id`, [np])).rows[0].id;
  await db.client.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true)`, [g, kid]);
  const ch = (await db.client.query(`insert into public.channels (group_id, kind, name) values ($1,'thread','G') returning id`, [g])).rows[0].id;
  await db.client.query(`insert into public.channel_members (channel_id, member_child_id, is_guardian_comember) values ($1,$2,false)`, [ch, kid]);
  const trigEv = (await db.client.query(`insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload) values ('membership',$1,$2,$3, jsonb_build_object('action','join')) returning id`, [np, kid, g])).rows[0].id;
  await db.client.query(`insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, role, status, idempotency_key) values ($1,'join',$2,$3,'member','pending',$4)`, [trigEv, g, kid, 's0:' + kid]);
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, ['0000f00d-0000-4000-8000-000000000002', kid, np]);

  const GT = [['memberships', 'member_child_id'], ['channel_members', 'member_child_id'], ['derivation_outbox', 'member_child_id'], ['tutor_grants', 'child_id']];
  // BEFORE purge: each seeded table has the child's row — so zero-after is non-vacuous AND the
  // disposition-VALUE assertions below pin purge_child's OWN accounting (not just FK cascade).
  const seeded = {};
  for (const [t, col] of GT) {
    seeded[t] = (await db.client.query(`select count(*)::int n from public.${t} where ${col}=$1`, [kid])).rows[0].n;
    assert.ok(seeded[t] >= 1, `seeded ${t} for the child`);
  }
  const seededSubjEvents = (await db.client.query(`select count(*)::int n from public.events where subject_child_id=$1`, [kid])).rows[0].n;
  assert.ok(seededSubjEvents >= 1, 'seeded subject events');

  const r = (await db.client.query(`select public.purge_child($1,$2,$3) r`, [kid, np, np])).rows[0].r;
  assert.equal(r.ok, true, 'purge_child ok');
  for (const [t, col] of GT) {
    assert.equal((await db.client.query(`select count(*)::int n from public.${t} where ${col}=$1`, [kid])).rows[0].n, 0, `${t}: zero residual`);
  }
  assert.equal((await db.client.query(`select count(*)::int n from public.events where subject_child_id=$1`, [kid])).rows[0].n, 0, 'events(subject): zero residual');
  // the receipt disposition VALUES equal the seeded counts — pins purge_child's OWN receipt
  // accounting (a regression dropping an explicit delete under-reports here even though FK cascade
  // still leaves zero residual — the COPPA covenant receipt must stay accurate).
  const del = r.disposition.deleted;
  assert.equal(del.memberships, seeded.memberships, 'receipt bucket: memberships');
  assert.equal(del.channel_members, seeded.channel_members, 'receipt bucket: channel_members');
  assert.equal(del.derivation_outbox, seeded.derivation_outbox, 'receipt bucket: derivation_outbox');
  assert.equal(del.tutor_grants, seeded.tutor_grants, 'receipt bucket: tutor_grants');
  assert.equal(del.subject_events, seededSubjEvents, 'receipt bucket: subject_events');
});

// S2 · create_group is authenticated-only + ZOMBIE-WRITE guarded. The RPC is SECURITY DEFINER
// (bypasses the groups_insert policy's `not actor_is_deleted` guard), so it must re-check itself.
test('S2: create_group is authenticated-only + zombie-write-guarded', async () => {
  await as('anon', null, async (c) => {
    await rejects(c, `select public.create_group('team','x',null)`, undefined, /permission denied/i, 'anon create_group');
  });
  // a DELETED actor (a deletion receipt exists for its uid) cannot create a group
  const zParent = '0000dea2-0000-4000-8000-000000000001';
  const zed = '0000dea2-0000-4000-8000-0000000000c1';
  await db.client.query(
    `insert into public.deletion_receipts (child_id, parent_id, child_auth_user_id, deleting_actor, disposition, receipt_hash)
     values (gen_random_uuid(), $1, $2, $1, '{}'::jsonb, 's2-zombie')`, [zParent, zed]);
  await as('authenticated', zed, async (c) => {
    assert.equal((await c.query(`select public.create_group('team','x',null) r`)).rows[0].r.error, 'not_authorized',
      'a deleted actor cannot create a group (zombie-write guard)');
  });
});

// Phase 4/5 · the deletion-covenant + moderation records are ADULT-keyed (parent_id = auth.uid()).
// A parent sees their OWN standing/receipts (transparency) but NEVER another family's — and can
// never forge or mutate them (the deleters/definer functions are the only writers).
test('covenant records (receipts, family standing): own-family read, cross-family zero, no client writes', async () => {
  // seed (committed, as owner) parent A's covenant rows — the shapes the deleters/moderation write
  await db.client.query(
    `insert into public.deletion_receipts (child_id, parent_id, deleting_actor, disposition, receipt_hash)
     values ($1,$2,$2,'{"deleted":{}}'::jsonb,'seed-hash-a1')`, [FIX.childA2, FIX.parentA]);
  await db.client.query(
    `insert into public.account_deletion_receipts (parent_id, deleting_actor, child_count, disposition, receipt_hash)
     values ($1,$1,0,'{"deleted":{}}'::jsonb,'seed-acct-hash-a')`, [FIX.parentA]);
  await db.client.query(
    `insert into public.family_standing (parent_id, flags, standing) values ($1, 1, 'good')`, [FIX.parentA]);

  // POSITIVE control: parent A sees exactly their own covenant rows
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal(await count(c, 'select 1 from public.deletion_receipts where parent_id = $1', [FIX.parentA]), 1);
    assert.equal(await count(c, 'select 1 from public.account_deletion_receipts where parent_id = $1', [FIX.parentA]), 1);
    assert.equal(await count(c, 'select 1 from public.family_standing where parent_id = $1', [FIX.parentA]), 1);
    // and cannot forge/mutate any of them (immutable, definer-written)
    await rejects(c, `insert into public.deletion_receipts (child_id, parent_id, deleting_actor, disposition, receipt_hash)
         values ($1,$2,$2,'{}'::jsonb,'forge')`, [FIX.childA1, FIX.parentA], /permission denied/i, 'forge deletion receipt');
    await rejects(c, `update public.family_standing set standing = 'good', flags = 0 where parent_id = $1`, [FIX.parentA], /permission denied/i, 'self-clear standing');
    await rejects(c, `insert into public.family_standing (parent_id, standing) values ($1,'good')`, [FIX.parentB], /permission denied/i, 'forge standing');
  });
  // cross-FAMILY: parent B sees none of family A's covenant rows
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.deletion_receipts where parent_id = $1', [FIX.parentA]), 0);
    assert.equal(await count(c, 'select 1 from public.account_deletion_receipts where parent_id = $1', [FIX.parentA]), 0);
    assert.equal(await count(c, 'select 1 from public.family_standing where parent_id = $1', [FIX.parentA]), 0);
  });
});

// The deletion machinery + policy tables are SERVICE/DEFINER ONLY: no authenticated grant at all.
// A leak here would expose legal holds, other families' purge queue, or let a client tamper with
// retention/export state — so every one must refuse a direct authenticated read.
test('deletion machinery tables are service-only: no authenticated client can read them', async () => {
  for (const t of ['legal_holds', 'deletion_attempts', 'retention_policy', 'receipt_exports', 'external_purge_queue']) {
    await as('authenticated', FIX.parentA, async (c) => {
      await rejects(c, `select 1 from public.${t} limit 1`, undefined, /permission denied/i, `authenticated read ${t}`);
    });
    await as('anon', null, async (c) => {
      await rejects(c, `select 1 from public.${t} limit 1`, undefined, /permission denied/i, `anon read ${t}`);
    });
  }
});

// The Slice-1 anchor SEAMS are service/definer ONLY. If a client could call
// mark_receipt_exported it could forge a CONFIRMED-export proof and let retention shred a
// receipt; list_receipts_awaiting_export would enumerate every family's deletion receipts.
// EXECUTE is granted to service_role only — both must refuse anon + authenticated callers.
test('receipt-anchor RPCs are service-only: no client can forge an export proof or list awaiting receipts', async () => {
  for (const [role, sub] of [['authenticated', FIX.parentA], ['anon', null]]) {
    await as(role, sub, async (c) => {
      await rejects(c, `select public.mark_receipt_exported($1, 'anchored')`, [FIX.childA1], /permission denied/i, `${role} mark_receipt_exported`);
      await rejects(c, `select * from public.list_receipts_awaiting_export(10, interval '0 minutes')`, undefined, /permission denied/i, `${role} list_receipts_awaiting_export`);
    });
  }
});
