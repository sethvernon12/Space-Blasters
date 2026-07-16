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

// S0 · fact (b) [S5a-updated]: provenance now lets a group_derived grant COEXIST with a
// parent_direct one for the same tutor+child (two DISJOINT partial unique indexes); a 2nd
// parent_direct or a 2nd (tutor,child,group) still collides; and the group_derived-IFF-group CHECK holds.
test('S0(b) [S5a]: parent_direct + group_derived grants coexist; both uniqueness keys + the CHECK behave', async () => {
  const tutorX = '0000f00d-0000-4000-8000-000000000001';
  const g1 = (await db.client.query(`insert into public.groups (purpose,name,created_by) values ('class','S0b G1',$1) returning id`, [FIX.parentA])).rows[0].id;
  const g2 = (await db.client.query(`insert into public.groups (purpose,name,created_by) values ('class','S0b G2',$1) returning id`, [FIX.parentA])).rows[0].id;
  // parent_direct (default origin) + a group_derived grant for the SAME tutor+child → COEXIST (was blocked pre-S5a)
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, [tutorX, FIX.childA1, FIX.parentA]);
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4)`, [tutorX, FIX.childA1, FIX.parentA, g1]);
  assert.equal((await db.client.query(`select count(*)::int n from public.tutor_grants where tutor_id=$1 and child_id=$2`, [tutorX, FIX.childA1])).rows[0].n, 2, 'parent_direct + group_derived coexist (2 rows, no collision)');
  // a 2nd parent_direct → collides on tutor_grants_parent_direct_uniq
  await assert.rejects(db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, [tutorX, FIX.childA1, FIX.parentB]), /duplicate key|unique/i, 'a 2nd parent_direct grant still collides');
  // a 2nd group_derived for the SAME (tutor,child,group) → collides on tutor_grants_group_derived_uniq
  await assert.rejects(db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4)`, [tutorX, FIX.childA1, FIX.parentB, g1]), /duplicate key|unique/i, 'a 2nd group_derived for the same (tutor,child,group) collides');
  // a group_derived for a DIFFERENT group → coexists (ref-count by multiplicity)
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4)`, [tutorX, FIX.childA1, FIX.parentA, g2]);
  assert.equal((await db.client.query(`select count(*)::int n from public.tutor_grants where tutor_id=$1 and child_id=$2`, [tutorX, FIX.childA1])).rows[0].n, 3, 'a second group (g2) adds a third coexisting grant');
  // the CHECK: group_derived REQUIRES a group; parent_direct FORBIDS one
  await assert.rejects(db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin) values ($1,$2,$3,true,'group_derived')`, ['0000f00d-0000-4000-8000-000000000009', FIX.childA1, FIX.parentA]), /origin_group_ck|check constraint/i, 'group_derived with NULL origin_group_id rejected by the CHECK');
  await assert.rejects(db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'parent_direct',$4)`, ['0000f00d-0000-4000-8000-00000000000a', FIX.childA1, FIX.parentA, g1]), /origin_group_ck|check constraint/i, 'parent_direct with a non-NULL origin_group_id rejected by the CHECK');
  // the EXACT redeem_invitation (0044) upsert clause is valid + upserts (insert→update, stays ONE row)
  const tUp = '0000f00d-0000-4000-8000-00000000000b';
  const UPS = `insert into public.tutor_grants (tutor_id, child_id, granted_by, can_write, active) values ($1,$2,$3,$4,true)
               on conflict (tutor_id, child_id) where origin='parent_direct' do update set can_write=excluded.can_write`;
  await db.client.query(UPS, [tUp, FIX.childB1, FIX.parentB, false]);
  await db.client.query(UPS, [tUp, FIX.childB1, FIX.parentB, true]);
  const up = (await db.client.query(`select count(*)::int n, bool_and(can_write) w from public.tutor_grants where tutor_id=$1 and child_id=$2`, [tUp, FIX.childB1])).rows[0];
  assert.deepEqual({ n: up.n, w: up.w }, { n: 1, w: true }, 'redeem_invitation upsert clause: on conflict (tutor,child) where origin=parent_direct → update, ONE row');
  await db.client.query(`delete from public.tutor_grants where tutor_id = any($1)`, [[tutorX, tUp]]);   // cleanup committed rows
  await db.client.query(`delete from public.groups where id = any($1)`, [[g1, g2]]);
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
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4)`, ['0000f00d-0000-4000-8000-000000000003', kid, np, g]);  // S5a: purge must delete BOTH origins
  await db.client.query(`insert into public.membership_requests (group_id, member_child_id, requested_by, status) values ($1,$2,$3,'pending')`, [g, kid, np]);  // S4: RESTRICT → purge_child must delete it

  const GT = [['memberships', 'member_child_id'], ['channel_members', 'member_child_id'], ['derivation_outbox', 'member_child_id'], ['tutor_grants', 'child_id'], ['membership_requests', 'member_child_id']];
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
  assert.equal(del.membership_requests, seeded.membership_requests, 'receipt bucket: membership_requests');
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

// ============================================================================
// GROUP ENGINE · S3 — ROSTER VISIBILITY. Purpose-dispatched roster reads (0041)
// + academy staff discovery (0042). Fixed synthetic uids so the committed seeds are
// idempotent; these tests run LAST (appended) so their committed academy fixtures
// never perturb the earlier isolation probes.
// ============================================================================
const S3 = {
  academyA:       '0000acad-0000-4000-8000-0000000000a1',
  director:       '0000acad-0000-4000-8000-0000000000d1',
  staffCleared:   '0000acad-0000-4000-8000-0000000000c1',   // academy tutor WITH a completed background check
  staffUncleared: '0000acad-0000-4000-8000-0000000000c2',   // academy tutor, role only, NO clearance
  academyB:       '0000acad-0000-4000-8000-0000000000b1',
  directorB:      '0000acad-0000-4000-8000-0000000000b2',
  staffB:         '0000acad-0000-4000-8000-0000000000b3',   // academy B staff (cross-academy foil)
  famA:           '0000fa00-0000-4000-8000-0000000000a1',
  famB:           '0000fa00-0000-4000-8000-0000000000b1',
  classGrp:       '0000c1a5-0000-4000-8000-000000000001',   // a class with a tutor-leader + 2 kids (diff families)
  classLeader:    '0000c1a5-0000-4000-8000-0000000000c1',
  standaloneGrp:  '0000a10e-0000-4000-8000-000000000001',   // an independent (non-academy) class
  standaloneLeader:'0000a10e-0000-4000-8000-0000000000c1',
};

// Idempotent, committed seed of the academy/class/standalone fixtures (on-conflict-do-nothing so
// both S3 tests can call it). childA1 (parentA) + childB1 (parentB) are consented; childA3 is not.
async function seedAcademy(client) {
  await client.query(`insert into public.groups (id, purpose, name, created_by) values
     ($1,'academy','Academy A',$2), ($3,'academy','Academy B',$4) on conflict (id) do nothing`,
     [S3.academyA, S3.director, S3.academyB, S3.directorB]);
  // enrolled family groups for parentA + parentB in Academy A (arena='academy', org_id=academyA)
  await client.query(`insert into public.groups (id, purpose, name, arena, org_id, created_by) values
     ($1,'family','Fam A','academy',$2,$3), ($4,'family','Fam B','academy',$2,$5) on conflict (id) do nothing`,
     [S3.famA, S3.academyA, FIX.parentA, S3.famB, FIX.parentB]);
  // academy memberships: parents (role='parent'); staff (role='tutor'); B has its own staff
  await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values
     ($1,$2,'parent',true), ($1,$3,'parent',true), ($1,$4,'tutor',true), ($1,$5,'tutor',true),
     ($6,$7,'tutor',true) on conflict do nothing`,
     [S3.academyA, FIX.parentA, FIX.parentB, S3.staffCleared, S3.staffUncleared, S3.academyB, S3.staffB]);
  // completed background checks: staffCleared (academy A) + staffB (academy B). staffUncleared gets NONE.
  await client.query(`insert into public.academy_staff_clearances (academy_group_id, actor_id, completed_at) values
     ($1,$2, now()), ($3,$4, now()) on conflict (academy_group_id, actor_id, check_kind) do nothing`,
     [S3.academyA, S3.staffCleared, S3.academyB, S3.staffB]);
  // a CLASS with a tutor-leader + two children from DIFFERENT families (child-roster narrowing)
  await client.query(`insert into public.groups (id, purpose, name, created_by) values ($1,'class','S3 Class',$2) on conflict (id) do nothing`, [S3.classGrp, S3.classLeader]);
  await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S3.classGrp, S3.classLeader]);
  await client.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true), ($1,$3,'member',true) on conflict do nothing`, [S3.classGrp, FIX.childA1, FIX.childB1]);
  // a STANDALONE class (independent leader, NOT academy staff of anything)
  await client.query(`insert into public.groups (id, purpose, name, created_by) values ($1,'class','Standalone',$2) on conflict (id) do nothing`, [S3.standaloneGrp, S3.standaloneLeader]);
  await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S3.standaloneGrp, S3.standaloneLeader]);
}

// S3a · purpose-dispatched roster visibility (0041): within-group adult communication PRESERVED,
// SEC-REV-27 CLOSED for academy parents, child rows narrowed to (own child OR the group's leader),
// is_group_leader a strictly-narrower derived index, can_view_child untouched.
test('S3a: purpose-dispatched roster — comms preserved, SEC-REV-27 closed for academy parents, child-roster narrowed to the leader', async () => {
  await seedAcademy(db.client);

  // (1) SEC-REV-27 CLOSED at the academy level: a plain parent cannot enumerate a peer parent.
  await as('authenticated', FIX.parentA, async (c) => {
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, FIX.parentA]) >= 1, 'academy parent reads OWN membership row');
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, FIX.parentB]), 0, 'SEC-REV-27: academy parent CANNOT enumerate a peer parent');
  });

  // (2) WITHIN-GROUP COMMUNICATION preserved: in a CLASS, co-member adults DO see one another.
  const comms = (await db.client.query(`insert into public.groups (purpose,name,created_by) values ('class','Comms Class',$1) returning id`, [S3.classLeader])).rows[0].id;
  await db.client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'member',true),($1,$3,'member',true)`, [comms, FIX.parentA, FIX.parentB]);
  await as('authenticated', FIX.parentA, async (c) => {
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [comms, FIX.parentB]) >= 1, 'within-group: a class co-member adult IS visible (comms preserved — NOT over-restricted)');
  });

  // (3) CHILD-ROSTER NARROWING: a plain co-member parent sees ONLY their own child; the leader sees all.
  await as('authenticated', FIX.parentA, async (c) => {
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S3.classGrp, FIX.childA1]) >= 1, 'co-parent sees OWN child membership row');
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S3.classGrp, FIX.childB1]), 0, 'co-parent CANNOT enumerate a classmate from another family');
  });
  await as('authenticated', S3.classLeader, async (c) => {
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id is not null', [S3.classGrp]), 2, 'the class LEADER sees the FULL child roster (both families)');
  });

  // (4) is_group_leader ⊊ is_group_member (derived index, strictly narrower).
  assert.equal((await db.client.query('select public.is_group_leader($1,$2) v', [S3.classGrp, S3.classLeader])).rows[0].v, true, 'leader → is_group_leader true');
  assert.equal((await db.client.query('select public.is_group_leader($1,$2) v', [S3.classGrp, FIX.parentA])).rows[0].v, false, 'a plain co-member parent is NOT a leader');
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal((await c.query('select public.is_group_member($1) v', [S3.classGrp])).rows[0].v, true, 'the same parent IS a member (guardian branch) — leader is strictly narrower');
  });

  // (5) can_view_child STAYS PRISTINE: the class leader (no tutor_grant) sees the roster but ZERO work.
  await as('authenticated', S3.classLeader, async (c) => {
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childB1])).rows[0].v, false, 'leader WITHOUT a grant: can_view_child = false');
    assert.equal(await count(c, 'select 1 from public.attempts where child_id=$1', [FIX.childB1]), 0, 'leader reads 0 of a rostered child’s work (name ≠ work; childB1 HAS a seeded attempt → non-vacuous)');
  });

  // (6) CHANNEL_MEMBERS purpose-dispatch mirrors memberships (INFO-1): seed a class channel with two
  //     adult co-members + a child. A co-member adult sees the OTHER adult (comms via channel_group) but
  //     0 of the child row (narrowed); the leader sees the child row. Proves the channel policy, not just membership.
  const chan = (await db.client.query(`insert into public.channels (group_id, kind, name) values ($1,'thread','S3 Chan') returning id`, [S3.classGrp])).rows[0].id;
  await db.client.query(`insert into public.channel_members (channel_id, member_actor_id) values ($1,$2),($1,$3)`, [chan, FIX.parentA, FIX.parentB]);
  await db.client.query(`insert into public.channel_members (channel_id, member_child_id) values ($1,$2)`, [chan, FIX.childA1]);
  await as('authenticated', FIX.parentB, async (c) => {
    assert.ok(await count(c, 'select 1 from public.channel_members where channel_id=$1 and member_actor_id=$2', [chan, FIX.parentA]) >= 1, 'channel: a class co-member adult IS visible (comms via channel_group)');
    assert.equal(await count(c, 'select 1 from public.channel_members where channel_id=$1 and member_child_id=$2', [chan, FIX.childA1]), 0, 'channel: a plain co-member CANNOT enumerate another family’s child channel row');
  });
  await as('authenticated', S3.classLeader, async (c) => {
    assert.equal(await count(c, 'select 1 from public.channel_members where channel_id=$1 and member_child_id=$2', [chan, FIX.childA1]), 1, 'channel: the LEADER sees the child channel row (via channel_group→is_group_leader)');
  });

  // (7) DIRECT ACADEMY CHILD-ROW narrowing (INFO-2): even if a child is a DIRECT member of the academy
  //     group, a plain academy parent cannot enumerate another family’s child row; the guardian can.
  await db.client.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true) on conflict do nothing`, [S3.academyA, FIX.childB1]);
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S3.academyA, FIX.childB1]), 0, 'academy: a plain parent cannot enumerate another family’s academy child row');
  });
  await as('authenticated', FIX.parentB, async (c) => {
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S3.academyA, FIX.childB1]) >= 1, 'academy: the child’s OWN guardian sees the row (positive control)');
  });
});

// S3b · academy staff discovery (0042): parent sees ALL staff (pick-a-leader), staff see the academy
// roster by NAME yet 0 work, all gated on a COMPLETED BACKGROUND CHECK; borders held; audited+minimized.
test('S3b: academy staff discovery — parent sees all staff, staff see academy kids by name yet 0 work, gated on a background check', async () => {
  await seedAcademy(db.client);

  // (6) PARENT CAN SEE ALL STAFF (cleared staff surfaced; uncleared not; peer parent still hidden).
  await as('authenticated', FIX.parentA, async (c) => {
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, S3.staffCleared]) >= 1, 'parent sees a CLEARED academy staff member (pick-a-leader)');
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, S3.staffUncleared]), 0, 'an UNCLEARED staff member is NOT surfaced (background-check gate)');
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, FIX.parentB]), 0, 'SEC-REV-27 stays closed under S3b: no peer-parent enumeration');
  });

  // (7) STAFF SEE THE ACADEMY ADULTS incl. parent connections.
  await as('authenticated', S3.staffCleared, async (c) => {
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, FIX.parentA]) >= 1, 'cleared staff sees parent A (connection)');
    assert.ok(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, FIX.parentB]) >= 1, 'cleared staff sees parent B (connection)');
  });

  // (8) CROWN JEWEL — academy_child_roster: names by nickname + parent, yet ZERO work without a grant.
  // NON-VACUOUS precondition (as owner, BEFORE the RLS probe): childB1 really has work — attempts (1) +
  // child_skill_mastery (1) seeded (seed.mjs). A can_view_child regression would flip the 0-checks below
  // from 0→1 and fail. (Run via db.client OUTSIDE the as()-txn so the owner sees past RLS.)
  assert.ok((await db.client.query('select count(*)::int n from public.attempts where child_id=$1', [FIX.childB1])).rows[0].n >= 1
    && (await db.client.query('select count(*)::int n from public.child_skill_mastery where child_id=$1', [FIX.childB1])).rows[0].n >= 1,
    'childB1 HAS seeded attempts + mastery (the crown-jewel 0-work check is non-vacuous)');
  await as('authenticated', S3.staffCleared, async (c) => {
    const roster = (await c.query('select child_id, nickname, parent_id from public.academy_child_roster($1) order by nickname', [S3.academyA])).rows;
    const ids = roster.map(r => r.child_id);
    assert.ok(ids.includes(FIX.childA1) && ids.includes(FIX.childB1), 'staff see enrolled children (both families) by name');
    assert.ok(!ids.includes(FIX.childA3), 'a NON-consented child is excluded (enrollment-is-consent)');
    assert.ok(roster.every(r => typeof r.nickname === 'string' && r.nickname.length > 0 && r.parent_id), 'roster carries nickname (minimized) + parent connection');
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childB1])).rows[0].v, false, 'name ≠ work: can_view_child = false WITHOUT a grant');
    // Defense-in-depth sweep across EVERY child-DATA table (attempts + child_skill_mastery are the
    // non-vacuous carriers proven above; the rest are a breadth guard).
    for (const t of ['attempts','sessions','child_skill_mastery','child_skill_misconception','assignments','submissions','teaching_artifacts','uploads','grade_jobs','grade_proposals']) {
      assert.equal(await count(c, `select 1 from public.${t} where child_id=$1`, [FIX.childB1]), 0, `staff reads 0 of the child’s ${t} (roster ≠ child-DATA)`);
    }
  });

  // (8b) SELF-ELEVATION DENIED (INFO-3, adversarial): a client can NEVER write a clearance to make
  //      itself academy staff — academy_staff_clearances is FORCE-RLS with zero policies (deny-by-default).
  await as('authenticated', FIX.parentB, async (c) => {
    await rejects(c, `insert into public.academy_staff_clearances (academy_group_id, actor_id, completed_at) values ($1,$2, now())`, [S3.academyA, FIX.parentB], /permission denied/i, 'client insert clearance (self-elevate)');
    await rejects(c, `update public.academy_staff_clearances set completed_at = now() where actor_id = $1`, [S3.staffUncleared], /permission denied/i, 'client update clearance');
    await rejects(c, `select 1 from public.academy_staff_clearances limit 1`, undefined, /permission denied/i, 'client read clearance');
  });

  // (9) a plain PARENT cannot call academy_child_roster (not staff → empty).
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal(await count(c, 'select 1 from public.academy_child_roster($1)', [S3.academyA]), 0, 'a plain parent gets NO academy child roster');
  });

  // (10) BACKGROUND-CHECK GATE (the SAFEGUARD binds): role-only tutor → empty; add a clearance → opens.
  await as('authenticated', S3.staffUncleared, async (c) => {
    assert.equal((await c.query('select public.is_academy_staff($1,$2) v', [S3.academyA, S3.staffUncleared])).rows[0].v, false, 'role label alone is NOT staff (needs a completed background check)');
    assert.equal(await count(c, 'select 1 from public.academy_child_roster($1)', [S3.academyA]), 0, 'uncleared staff: no child roster');
  });
  await db.client.query(`insert into public.academy_staff_clearances (academy_group_id, actor_id, completed_at) values ($1,$2, now())
     on conflict (academy_group_id, actor_id, check_kind) do update set completed_at = now(), revoked_at = null`, [S3.academyA, S3.staffUncleared]);
  await as('authenticated', S3.staffUncleared, async (c) => {
    assert.equal((await c.query('select public.is_academy_staff($1,$2) v', [S3.academyA, S3.staffUncleared])).rows[0].v, true, 'after a completed background check, the gate BINDS → staff');
    assert.ok(await count(c, 'select 1 from public.academy_child_roster($1)', [S3.academyA]) >= 1, 'now the roster opens (proves the gate is real, not a no-op)');
  });

  // (11) STANDALONE + CROSS-ACADEMY BORDERS: neither reads Academy A’s roster.
  await as('authenticated', S3.standaloneLeader, async (c) => {
    assert.equal((await c.query('select public.is_group_leader($1,$2) v', [S3.standaloneGrp, S3.standaloneLeader])).rows[0].v, true, 'a standalone leader DOES lead their OWN group');
    assert.equal((await c.query('select public.is_academy_staff($1,$2) v', [S3.academyA, S3.standaloneLeader])).rows[0].v, false, 'but is NEVER academy staff');
    assert.equal(await count(c, 'select 1 from public.academy_child_roster($1)', [S3.academyA]), 0, 'standalone leader: 0 academy roster');
  });
  await as('authenticated', S3.staffB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.academy_child_roster($1)', [S3.academyA]), 0, 'Academy B staff read 0 of Academy A’s roster (cross-academy border)');
  });

  // (12) AUDITED + MINIMIZED: a roster view writes an audit row carrying WHO + WHICH academy, NO child PII.
  await as('authenticated', S3.staffCleared, async (c) => {
    await c.query('select 1 from public.academy_child_roster($1)', [S3.academyA]);   // view (audits inside this tx)
    const audits = (await c.query(`select child_id, detail from public.audit_log where action='academy.child_roster.view' and actor_id=$1`, [S3.staffCleared])).rows;
    assert.ok(audits.length >= 1, 'a roster view is audited (own actor reads own audit row)');
    assert.ok(audits.every(a => a.child_id === null && a.detail.academy_group_id === S3.academyA), 'audit carries WHO + WHICH academy, NO child PII (child_id null)');
  });
});

// ============================================================================
// GROUP ENGINE · S4 — DISTRIBUTED SPLIT-GATE ADD (0043). Relaxed join_group ACTIVE lane
// (can_write_child gate byte-for-byte) + the PENDING cross-family request lane
// (membership_requests: NO membership until the child's own parent confirms). Fixed uids;
// write flows run inside ONE as()-txn with jwt-sub switching (rolled back). `reset role`
// becomes the superuser to run the worker drain (revoked from authenticated/service_role).
// ============================================================================
const S4 = {
  cls:        '0000c1a5-0000-4000-8000-000000000004',   // a stranger-led class (no academy)
  leader:     '0000c1a5-0000-4000-8000-0000000000c4',
  acadCls:    '0000c1a5-0000-4000-8000-000000000005',   // a class OWNED by Academy A (org_id = S3.academyA)
  acadLeader: '0000c1a5-0000-4000-8000-0000000000c5',
  stranger:   '0000577a-0000-4000-8000-000000000001',   // not a leader / staff / parent
};
async function seedS4(client) {
  await client.query(`insert into public.groups (id, purpose, name, created_by) values ($1,'class','S4 Class',$2) on conflict (id) do nothing`, [S4.cls, S4.leader]);
  await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S4.cls, S4.leader]);
  await client.query(`insert into public.groups (id, purpose, name, org_id, created_by) values ($1,'class','S4 Acad Class',$2,$3) on conflict (id) do nothing`, [S4.acadCls, S3.academyA, S4.acadLeader]);
  await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S4.acadCls, S4.acadLeader]);
}
const be = async (c, sub) => { await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]); };

// S4a — relaxed ACTIVE lane: distributed WHO, can_write_child border byte-for-byte; DER-11 preserved.
test('S4a: distributed active add — parent adds own child to any class; cross-family refused; DER-11 hold preserved', async () => {
  await seedAcademy(db.client); await seedS4(db.client);

  // (1) OWN-CHILD active add to a class the parent does NOT own → active; leader sees it; other family 0.
  await as('authenticated', FIX.parentA, async (c) => {
    const r = (await c.query(`select public.join_group($1,$2,null,'member') r`, [S4.cls, FIX.childA1])).rows[0].r;
    assert.equal(r.ok, true, 'parent adds OWN child to a class they do NOT own → ACTIVE (distributed easy-in)');
    await be(c, S4.leader);
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2 and active', [S4.cls, FIX.childA1]), 1, 'the leader sees childA1 active on the roster (is_group_leader)');
    await be(c, FIX.parentB);
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S4.cls, FIX.childA1]), 0, 'another family reads 0 (cross-family)');
  });

  // (border) CROSS-FAMILY active add is REFUSED — can_write_child gate UNCHANGED (C1 invariant).
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal((await c.query(`select public.join_group($1,$2,null,'member') r`, [S4.cls, FIX.childB1])).rows[0].r.error, 'not_authorized',
      'parentA CANNOT actively add childB1 (cross-family; can_write_child border preserved byte-for-byte)');
  });

  // (7) a stranger (not leader/staff/parent) can neither active-add nor request.
  await as('authenticated', S4.stranger, async (c) => {
    assert.equal((await c.query(`select public.join_group($1,$2,null,'member') r`, [S4.cls, FIX.childA1])).rows[0].r.error, 'not_authorized', 'stranger active add refused (no can_write_child)');
    assert.equal((await c.query(`select public.request_add($1,$2) r`, [S4.cls, FIX.childB1])).rows[0].r.error, 'not_authorized', 'stranger request_add refused (not leader/staff)');
  });

  // (INFO-2) a CHILD login cannot self-enroll — can_write_child(self) is true, so the parent-in-the-loop
  // guard (COPPA) must block it explicitly. (childA1Login is childA1's own auth user.)
  await as('authenticated', FIX.childA1Login, async (c) => {
    assert.equal((await c.query(`select public.join_group($1,$2,null,'member') r`, [S4.cls, FIX.childA1])).rows[0].r.error, 'not_authorized', 'a child login CANNOT self-enroll into a class (parent-in-the-loop)');
  });

  // (11) DER-11 preserved: an OWN-child active add of a NO-consent child → membership created, drain HOLDS.
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal((await c.query(`select public.join_group($1,$2,null,'member') r`, [S4.cls, FIX.childA3])).rows[0].r.ok, true, 'own-child active add succeeds even for a no-consent child (membership created)');
    await c.query('reset role');                                   // superuser → run the worker drain
    await c.query('select public.drain_derivations()');
    assert.equal((await c.query(`select status from public.derivation_outbox where group_id=$1 and member_child_id=$2`, [S4.cls, FIX.childA3])).rows[0].status, 'held',
      'DER-11: a no-consent child → outbox HELD (nothing derived) — preserved under the relaxed lane');
  });
});

// S4b — the PENDING cross-family lane: request → HELD (no membership) → parent confirms → active.
test('S4b: cross-family request is HELD (no membership) and never surfaces, until the child’s own parent confirms', async () => {
  await seedAcademy(db.client); await seedS4(db.client);
  await as('authenticated', S4.leader, async (c) => {
    // (2) leader requests a cross-family child → pending REQUEST, and NOTHING is materialized.
    const reqId = (await c.query(`select public.request_add($1,$2,'member','fill a gap') r`, [S4.cls, FIX.childB1])).rows[0].r.request_id;
    assert.ok(reqId, 'leader requests a cross-family child → a pending request id');
    await c.query('reset role');                                   // superuser: prove ABSENCE (not RLS-hidden)
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S4.cls, FIX.childB1]), 0, 'HELD: NO membership row (border by absence)');
    assert.equal(await count(c, 'select 1 from public.derivation_outbox where group_id=$1 and member_child_id=$2', [S4.cls, FIX.childB1]), 0, 'HELD: NO outbox row');
    assert.equal(await count(c, 'select 1 from public.channel_members cm join public.channels ch on ch.id=cm.channel_id where ch.group_id=$1 and cm.member_child_id=$2', [S4.cls, FIX.childB1]), 0, 'HELD: NO channel co-membership');

    // (3) the held add never surfaces to the leader as a ROSTER member; work stays 0.
    await c.query('set local role authenticated'); await be(c, S4.leader);
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S4.cls, FIX.childB1]), 0, 'leader sees NO membership for the pending child');
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childB1])).rows[0].v, false, 'leader: can_view_child=false (no grant; work is S5)');
    assert.equal(await count(c, 'select 1 from public.my_pending_add_requests() where id=$1', [reqId]), 1, 'the requester sees their OWN pending request');

    // (4) the child's OWN parent sees the pending request (cockpit); another family does NOT.
    await be(c, FIX.parentB);
    assert.equal(await count(c, 'select 1 from public.my_pending_add_requests() where id=$1', [reqId]), 1, 'the child’s parent sees the pending request (cockpit / self-correct path)');
    await be(c, FIX.parentA);
    assert.equal(await count(c, 'select 1 from public.my_pending_add_requests() where id=$1', [reqId]), 0, 'another family does NOT see the pending request (border)');

    // (6) confirm authz: the requester/leader CANNOT self-confirm.
    await be(c, S4.leader);
    assert.equal((await c.query(`select public.confirm_add($1) r`, [reqId])).rows[0].r.error, 'not_authorized', 'the requester CANNOT self-confirm (only the child’s parent)');

    // (5) the parent confirms → active; drain derives participation; leader sees the roster identity.
    await be(c, FIX.parentB);
    assert.equal((await c.query(`select public.confirm_add($1) r`, [reqId])).rows[0].r.ok, true, 'the child’s own parent confirms → active');
    await c.query('reset role');                                   // membership_requests is deny-by-default (RPC-only); read status as superuser
    assert.equal((await c.query(`select status from public.membership_requests where id=$1`, [reqId])).rows[0].status, 'confirmed', 'request → confirmed');
    await c.query('select public.drain_derivations()');
    assert.equal(await count(c, 'select 1 from public.channel_members cm join public.channels ch on ch.id=cm.channel_id where ch.group_id=$1 and cm.member_child_id=$2', [S4.cls, FIX.childB1]), 1, 'after confirm + drain: the child PARTICIPATES (channel co-membership derived)');

    // (8) leader now sees the roster identity but STILL 0 work (can_view_child pristine — S5 owns the grant).
    await c.query('set local role authenticated'); await be(c, S4.leader);
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2 and active', [S4.cls, FIX.childB1]), 1, 'after confirm: leader sees childB1 active on the roster');
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childB1])).rows[0].v, false, 'after confirm: leader STILL 0 work (can_view_child false)');
  });
});

// S4c — request-lane borders + idempotent + reversible (decline/cancel) + S3 still holds.
test('S4c: request-lane borders, idempotent request, reversible decline/cancel; S3 rules still hold', async () => {
  await seedAcademy(db.client); await seedS4(db.client);

  // (10) academy-staff request path (via org_id) + cross-academy border.
  await as('authenticated', S3.staffCleared, async (c) => {
    assert.equal((await c.query(`select public.request_add($1,$2) r`, [S4.acadCls, FIX.childB1])).rows[0].r.ok, true, 'academy staff can request into a class OWNED by THEIR academy (org_id)');
  });
  await as('authenticated', S3.staffB, async (c) => {
    assert.equal((await c.query(`select public.request_add($1,$2) r`, [S4.acadCls, FIX.childB1])).rows[0].r.error, 'not_authorized', 'academy B staff CANNOT request into academy A’s class (cross-academy border)');
  });

  // (12a) idempotent: a re-request for the same (group, child) returns the SAME id (no duplicate).
  await as('authenticated', S4.leader, async (c) => {
    const a = (await c.query(`select public.request_add($1,$2) r`, [S4.cls, FIX.childB1])).rows[0].r;
    const b = (await c.query(`select public.request_add($1,$2) r`, [S4.cls, FIX.childB1])).rows[0].r;
    assert.equal(a.request_id, b.request_id, 'a re-request returns the existing pending (no duplicate)');
  });

  // (12b) reversible: the parent DECLINES → declined, no membership; the requester CANCELS → cancelled.
  await as('authenticated', S4.leader, async (c) => {
    const reqId = (await c.query(`select public.request_add($1,$2) r`, [S4.cls, FIX.childB1])).rows[0].r.request_id;
    await be(c, FIX.parentB);
    assert.equal((await c.query(`select public.decline_add($1,'not this class') r`, [reqId])).rows[0].r.status, 'declined', 'the child’s parent declines → declined');
    await c.query('reset role');
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_child_id=$2', [S4.cls, FIX.childB1]), 0, 'a declined request materializes NO membership');
  });
  await as('authenticated', S4.leader, async (c) => {
    const reqId = (await c.query(`select public.request_add($1,$2) r`, [S4.cls, FIX.childB1])).rows[0].r.request_id;
    assert.equal((await c.query(`select public.decline_add($1) r`, [reqId])).rows[0].r.status, 'cancelled', 'the requester cancels their OWN request → cancelled');
  });

  // (INFO-2) a CHILD cannot confirm a request about themselves (self-consent blocked); the parent can.
  await as('authenticated', S4.leader, async (c) => {
    const reqId = (await c.query(`select public.request_add($1,$2) r`, [S4.cls, FIX.childA1])).rows[0].r.request_id;
    await be(c, FIX.childA1Login);
    assert.equal((await c.query(`select public.confirm_add($1) r`, [reqId])).rows[0].r.error, 'not_authorized', 'a child CANNOT confirm a request about themselves (parent-in-the-loop)');
    await be(c, FIX.parentA);
    assert.equal((await c.query(`select public.confirm_add($1) r`, [reqId])).rows[0].r.ok, true, 'the child’s PARENT confirms → ok');
  });

  // (SHOULD-FIX 1) deny-by-default PIN: membership_requests is RPC-only — no client read/write/self-elevate.
  await as('authenticated', FIX.parentB, async (c) => {
    await rejects(c, `select 1 from public.membership_requests limit 1`, undefined, /permission denied/i, 'client read membership_requests');
    await rejects(c, `insert into public.membership_requests (group_id, member_child_id, requested_by) values ($1,$2,$3)`, [S4.cls, FIX.childB1, FIX.parentB], /permission denied/i, 'client insert membership_requests (self-elevate)');
    await rejects(c, `update public.membership_requests set status='confirmed' where member_child_id=$1`, [FIX.childB1], /permission denied/i, 'client update membership_requests');
  });
  await as('anon', null, async (c) => {
    await rejects(c, `select 1 from public.membership_requests limit 1`, undefined, /permission denied/i, 'anon read membership_requests');
  });

  // (9) S3 roster rules still hold under S4 (spot re-check: SEC-REV-27 closed for academy parents).
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal(await count(c, 'select 1 from public.memberships where group_id=$1 and member_actor_id=$2', [S3.academyA, FIX.parentB]), 0, 'S3 still holds: an academy parent cannot enumerate a peer parent');
  });
});

// ============================================================================
// GROUP ENGINE · S5a — GRANT PROVENANCE (0044). Table-prep: can_view_child stays byte-for-byte
// (is_my_child OR EXISTS active grant), origin-agnostic; ref-count is realized by row multiplicity
// (one group_derived grant per justifying group); the client forge (origin='group_derived') is closed.
// Grants seeded via db.client (owner) stand in for the S5b server-side mint path.
// ============================================================================
test('S5a: can_view_child origin-agnostic; ref-count by multiplicity; client forge closed; parent_direct client insert preserved', async () => {
  const tutP = '0000fa5a-0000-4000-8000-000000000001';   // parent_direct grant only
  const tutG = '0000fa5a-0000-4000-8000-000000000002';   // group_derived grant only
  const tutB = '0000fa5a-0000-4000-8000-000000000003';   // BOTH
  const tutR = '0000fa5a-0000-4000-8000-000000000004';   // ref-count: two group_derived (two groups)
  const gA = (await db.client.query(`insert into public.groups (purpose,name,created_by) values ('class','S5a gA',$1) returning id`, [FIX.parentA])).rows[0].id;
  const gB = (await db.client.query(`insert into public.groups (purpose,name,created_by) values ('class','S5a gB',$1) returning id`, [FIX.parentA])).rows[0].id;
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, [tutP, FIX.childA1, FIX.parentA]);
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4)`, [tutG, FIX.childA1, FIX.parentA, gA]);
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, [tutB, FIX.childA1, FIX.parentA]);
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4)`, [tutB, FIX.childA1, FIX.parentA, gA]);
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4),($1,$2,$3,true,'group_derived',$5)`, [tutR, FIX.childA1, FIX.parentA, gA, gB]);

  // (5) origin-agnostic: can_view_child true via parent_direct-only, group_derived-only, and both.
  for (const [t, label] of [[tutP, 'parent_direct only'], [tutG, 'group_derived only'], [tutB, 'both']]) {
    await as('authenticated', t, async (c) => {
      assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, `can_view_child true via ${label} grant`);
      assert.equal(await count(c, 'select 1 from public.children where id=$1', [FIX.childA1]), 1, `tutor sees the child via ${label}`);
    });
  }

  // (6) ref-count by multiplicity: tutR has two group grants (gA, gB). Revoke gA → still true; revoke gB → false.
  await as('authenticated', tutR, async (c) => {
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'two justifying group grants → can_view_child true');
  });
  await db.client.query(`update public.tutor_grants set active=false, revoked_at=now() where tutor_id=$1 and origin_group_id=$2`, [tutR, gA]);
  await as('authenticated', tutR, async (c) => {
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'revoke ONE group grant → access RETAINED (the other still justifies)');
  });
  await db.client.query(`update public.tutor_grants set active=false, revoked_at=now() where tutor_id=$1 and origin_group_id=$2`, [tutR, gB]);
  await as('authenticated', tutR, async (c) => {
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'revoke the LAST justifying grant → access DROPS (no lingering)');
  });

  // (7) the CLIENT FORGE is CLOSED: a parent cannot client-insert a group_derived grant; parent_direct still works.
  await as('authenticated', FIX.parentA, async (c) => {
    await rejects(c, `insert into public.tutor_grants (tutor_id, child_id, granted_by, active, origin, origin_group_id) values ($1,$2,$3,true,'group_derived',$4)`,
      ['0000fa5a-0000-4000-8000-0000000000ff', FIX.childA1, FIX.parentA, gA], /row-level security|policy/i, 'a parent CANNOT client-forge a group_derived grant (RLS WITH CHECK origin=parent_direct)');
    assert.equal((await c.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true) returning id`, ['0000fa5a-0000-4000-8000-0000000000fe', FIX.childA1, FIX.parentA])).rowCount, 1,
      'a parent CAN still client-insert a parent_direct grant (behavior preserved)');
    // and a parent CANNOT client-manage a group_derived grant (system-managed): the update policy hides it → 0 rows.
    const upd = await c.query(`update public.tutor_grants set active=true, revoked_at=null where tutor_id=$1 and child_id=$2`, [tutG, FIX.childA1]);
    assert.equal(upd.rowCount, 0, 'a parent CANNOT client-update a group_derived grant (update policy scoped to parent_direct)');
  });

  await db.client.query(`delete from public.tutor_grants where tutor_id = any($1)`, [[tutP, tutG, tutB, tutR]]);   // cleanup committed rows
  await db.client.query(`delete from public.groups where id = any($1)`, [[gA, gB]]);
});
