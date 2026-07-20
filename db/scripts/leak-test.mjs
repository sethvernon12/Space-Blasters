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
  await db.client.query(`insert into public.membership_removals (kind, group_id, member_child_id, actor_id, note) values ('removed',$1,$2,$3,'S0 note')`, [g, kid, np]);  // S6: RESTRICT → purge_child must delete it

  const GT = [['memberships', 'member_child_id'], ['channel_members', 'member_child_id'], ['derivation_outbox', 'member_child_id'], ['tutor_grants', 'child_id'], ['membership_requests', 'member_child_id'], ['membership_removals', 'member_child_id']];
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
  assert.equal(del.membership_removals, seeded.membership_removals, 'receipt bucket: membership_removals');
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

// ============================================================================
// GROUP ENGINE · S5b — CO-MINT / REVOKE RECONCILE (0045). A VERIFIED leader gains the
// WORK view (can_view_child) when a parent-authorized ACTIVE membership lands, via a
// RECONCILED PROJECTION of membership truth in the drain (order-insensitive); revoked
// (audited, synchronous) on membership-end. Write flows run in ONE as()-txn: writes as
// authenticated, `reset role` → superuser to run the drain, assert as the leader/parent.
// ============================================================================
const S5B = {
  standClass:  '0000513b-0000-4000-8000-000000000001',   // standalone class, VERIFIED leader
  standLeader: '0000513b-0000-4000-8000-0000000000c1',
  standClass2: '0000513b-0000-4000-8000-000000000002',   // second class, SAME verified leader (ref-count)
  unverClass:  '0000513b-0000-4000-8000-000000000003',   // standalone class, UNVERIFIED leader
  unverLeader: '0000513b-0000-4000-8000-0000000000c3',
  acadClass:   '0000513b-0000-4000-8000-000000000004',   // academy-attached class (org_id=academyA), leader=staffCleared (background-checked)
};
async function seedS5b(client) {
  await seedAcademy(client);
  await client.query(`insert into public.standalone_leader_clearances (actor_id, completed_at) values ($1, now()) on conflict (actor_id, check_kind) do nothing`, [S5B.standLeader]);
  for (const [g, n] of [[S5B.standClass, 'S5b Stand'], [S5B.standClass2, 'S5b Stand2']]) {
    await client.query(`insert into public.groups (id, purpose, name, created_by) values ($1,'class',$2,$3) on conflict (id) do nothing`, [g, n, S5B.standLeader]);
    await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [g, S5B.standLeader]);
  }
  await client.query(`insert into public.groups (id, purpose, name, created_by) values ($1,'class','S5b Unver',$2) on conflict (id) do nothing`, [S5B.unverClass, S5B.unverLeader]);
  await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S5B.unverClass, S5B.unverLeader]);
  // academy-attached class (org_id=academyA) led by the BACKGROUND-CHECKED academy staff (S3.staffCleared)
  await client.query(`insert into public.groups (id, purpose, name, org_id, created_by) values ($1,'class','S5b Acad',$2,$3) on conflict (id) do nothing`, [S5B.acadClass, S3.academyA, S3.staffCleared]);
  await client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S5B.acadClass, S3.staffCleared]);
}
// drain as superuser, then return to an authenticated probe as `sub`
const drainAs = async (c, sub) => { await c.query('reset role'); await c.query('select public.drain_derivations()'); await c.query('set local role authenticated'); if (sub) await be(c, sub); };

test('S5b-a: co-mint on join for a VERIFIED leader; unverified→no view; held/cross-family→no grant', async () => {
  await seedS5b(db.client);
  // (1) verified standalone leader gains the WORK view after a parent adds their own child + drain
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await drainAs(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'verified leader gains can_view_child after co-mint');
    assert.equal((await c.query('select public.can_write_child($1) v', [FIX.childA1])).rows[0].v, true, 'the group_derived grant is writable (leaders grade/annotate)');
    assert.equal(await count(c, `select 1 from public.tutor_grants where tutor_id=$1 and child_id=$2 and origin='group_derived' and origin_group_id=$3 and active`, [S5B.standLeader, FIX.childA1, S5B.standClass]), 1, 'one active group_derived grant minted');
    await c.query('reset role');
    assert.ok((await c.query(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='disclosure' and detail->>'origin'='group_derived' and (detail->>'origin_group_id')=$2`, [FIX.childA1, S5B.standClass])).rows[0].n >= 1, 'a provenance-complete group_derived disclosure ledger row was written');
  });
  // (2) UNVERIFIED standalone leader → NO work-view (co-mint gated on verification)
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.unverClass, FIX.childA2]);
    await drainAs(c, S5B.unverLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA2])).rows[0].v, false, 'UNVERIFIED standalone leader gets NO work-view');
  });
  // (3) HELD no-consent child → drain holds → NO co-mint
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA3]);   // childA3 has NO consent
    await drainAs(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA3])).rows[0].v, false, 'a no-consent child → drain HELD → no co-mint');
  });
  // (4) cross-family PENDING request → no membership → no co-mint
  await as('authenticated', S5B.standLeader, async (c) => {
    await c.query(`select public.request_add($1,$2) r`, [S5B.standClass, FIX.childB1]);   // parentB's child (cross-family)
    await drainAs(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childB1])).rows[0].v, false, 'a cross-family pending request → no membership → no co-mint');
  });
});

test('S5b-b: synchronous leave cut (immediate + audited); ref-count over two classes; re-add re-discloses', async () => {
  await seedS5b(db.client);
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass2, FIX.childA1]);
    await drainAs(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'two class memberships → work-view');
    assert.equal(await count(c, `select 1 from public.tutor_grants where tutor_id=$1 and child_id=$2 and origin='group_derived' and active`, [S5B.standLeader, FIX.childA1]), 2, 'two active group_derived grants (one per class)');
    // leave ONE class → SYNCHRONOUS cut of that grant; access RETAINED via the other (no drain)
    await be(c, FIX.parentA);
    await c.query(`select public.leave_group($1,$2,null)`, [S5B.standClass, FIX.childA1]);
    await be(c, S5B.standLeader);
    assert.equal(await count(c, `select 1 from public.tutor_grants where tutor_id=$1 and origin_group_id=$2 and active`, [S5B.standLeader, S5B.standClass]), 0, 'the left class grant is revoked SYNCHRONOUSLY (no drain)');
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'ref-count: access RETAINED via the still-active second class');
    // leave the SECOND → access DROPS immediately
    await be(c, FIX.parentA);
    await c.query(`select public.leave_group($1,$2,null)`, [S5B.standClass2, FIX.childA1]);
    await be(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'leaving the LAST justifying class → access DROPS immediately (synchronous cut)');
    await c.query('reset role');
    assert.ok((await c.query(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='revoke' and detail->>'origin'='group_derived'`, [FIX.childA1])).rows[0].n >= 2, 'each leave wrote an audited group_derived revoke ledger row');
  });
  // re-add re-discloses (fresh disclosure, not a silent reactivation)
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await drainAs(c);
    await c.query(`select public.leave_group($1,$2,null)`, [S5B.standClass, FIX.childA1]);   // revoke
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);  // re-add
    await c.query('reset role'); await c.query('select public.drain_derivations()');
    assert.ok((await c.query(`select count(*)::int n from public.consent_ledger where child_id=$1 and action='disclosure' and detail->>'origin'='group_derived' and (detail->>'origin_group_id')=$2`, [FIX.childA1, S5B.standClass])).rows[0].n >= 2, 're-add wrote a FRESH disclosure ledger row (not a silent reactivation) — HARD RULE #7');
  });
});

test('S5b-c: reconcile-to-truth ignores a stale/reordered event; null-parent no-wedge; consent-filter', async () => {
  await seedS5b(db.client);
  // (churn/reorder REGRESSION) a stale LEAVE event while the membership is STILL ACTIVE → grant stays active
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await c.query('reset role'); await c.query('select public.drain_derivations()');   // co-mint
    const staleEv = (await c.query(`insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload) values ('membership',$1,$2,$3, jsonb_build_object('action','leave')) returning id`, [S5B.standLeader, FIX.childA1, S5B.standClass])).rows[0].id;
    await c.query(`insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, role, status, idempotency_key)
                   values ($1,'leave',$2,$3,'member','pending','stale-leave-a1')`, [staleEv, S5B.standClass, FIX.childA1]);   // STALE leave, membership still active
    await c.query('select public.drain_derivations()');
    await c.query('set local role authenticated'); await be(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true,
      'reconcile-to-truth: a stale LEAVE with the membership still ACTIVE does NOT revoke (a naive revoke-on-leave would) — grant follows membership truth');
  });
  // (null-parent NO-WEDGE) a consented child with parent_id NULL is skipped; the drain still processes a normal child
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query('reset role');
    const npc = '0000513b-0000-4000-8000-0000000000f1', npLogin = '0000513b-0000-4000-8000-0000000000f2';
    await c.query(`insert into public.children (id, parent_id, auth_user_id, nickname, grade_band) values ($1, null, $2, 'NullPar', 'K')`, [npc, npLogin]);
    const cid = (await c.query(`insert into public.consent_ledger (parent_id, child_id, action, method, policy_version) values ($1,$2,'grant','other_vpc','x') returning id`, [npLogin, npc])).rows[0].id;
    await c.query(`update public.children set consent_id=$1 where id=$2`, [cid, npc]);   // consented but parent_id NULL
    await c.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true), ($1,$3,'member',true) on conflict do nothing`, [S5B.standClass, npc, FIX.childA1]);
    const evNp = (await c.query(`insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload) values ('membership',$1,$2,$3,'{}'::jsonb) returning id`, [npLogin, npc, S5B.standClass])).rows[0].id;
    const evNorm = (await c.query(`insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload) values ('membership',$1,$2,$3,'{}'::jsonb) returning id`, [FIX.parentA, FIX.childA1, S5B.standClass])).rows[0].id;
    await c.query(`insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, role, status, idempotency_key) values
                   ($1,'join',$3,$4,'member','pending','np-join-key'), ($2,'join',$3,$5,'member','pending','norm-join-key')`, [evNp, evNorm, S5B.standClass, npc, FIX.childA1]);
    const r = (await c.query('select public.drain_derivations() r')).rows[0].r;
    assert.ok(r.processed >= 2, 'drain COMPLETED both rows (no poison-pill wedge on the null-parent child)');
    assert.equal((await c.query(`select count(*)::int n from public.tutor_grants where child_id=$1 and origin='group_derived'`, [npc])).rows[0].n, 0, 'null-parent child: NO co-mint (skipped, no wedge)');
    assert.equal((await c.query(`select count(*)::int n from public.tutor_grants where child_id=$1 and origin_group_id=$2 and active`, [FIX.childA1, S5B.standClass])).rows[0].n, 1, 'a NORMAL child in the same drain still got its grant (drain did not wedge)');
  });
  // (CONSENT FILTER — the leader-join fan-out relies on it) reconcile a NO-CONSENT member → no mint
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query('reset role');
    await c.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true) on conflict do nothing`, [S5B.standClass, FIX.childA3]);  // childA3 NO consent
    await c.query(`select public.reconcile_group_grant($1,$2)`, [S5B.standClass, FIX.childA3]);
    assert.equal((await c.query(`select count(*)::int n from public.tutor_grants where child_id=$1 and origin='group_derived'`, [FIX.childA3])).rows[0].n, 0, 'reconcile refuses to mint for a no-consent member (the leader-join fan-out inherits this filter)');
  });
});

test('S5b-d: re-drivers (consent-grant + clearance) retroactively mint; de-verification revokes; union access', async () => {
  await seedS5b(db.client);
  // (CONSENT-GRANT RE-DRIVER) child added before consent → held; consent lands → the children trigger reconciles → co-mint
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA3]);   // childA3 no consent → active membership, held derivation
    await drainAs(c);
    await c.query('reset role');
    const cid = (await c.query(`insert into public.consent_ledger (parent_id, child_id, action, method, policy_version) values ($1,$2,'grant','other_vpc','x') returning id`, [FIX.parentA, FIX.childA3])).rows[0].id;
    await c.query(`update public.children set consent_id=$1 where id=$2`, [cid, FIX.childA3]);   // consent lands → trigger → redrive → reconcile
    await c.query('set local role authenticated'); await be(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA3])).rows[0].v, true, 'consent-grant RE-DRIVER retroactively co-mints a consented-after-join child');
  });
  // (CLEARANCE RE-DRIVER) child in the UNVERIFIED class; the leader gets a clearance → retroactive co-mint; then de-verify → revoke
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.unverClass, FIX.childA1]);
    await drainAs(c, S5B.unverLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'before verification: no work-view');
    await c.query('reset role');
    await c.query(`insert into public.standalone_leader_clearances (actor_id, completed_at) values ($1, now()) on conflict (actor_id, check_kind) do update set completed_at=now(), revoked_at=null`, [S5B.unverLeader]);  // clearance lands → trigger → redrive
    await c.query('set local role authenticated'); await be(c, S5B.unverLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'clearance-completion RE-DRIVER retroactively co-mints for a verified-after-join leader');
    // DE-VERIFY → the grant is revoked (verification also gates existing rows via reconcile)
    await c.query('reset role');
    await c.query(`update public.standalone_leader_clearances set revoked_at=now() where actor_id=$1`, [S5B.unverLeader]);  // de-verify → trigger → redrive → revoke
    await c.query('set local role authenticated'); await be(c, S5B.unverLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'de-verifying the leader (clearance revoked) REVOKES the group_derived grant');
  });
  // (UNION ACCESS) a child with BOTH a parent_direct AND a group_derived grant → revoking parent_direct does NOT sever
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await drainAs(c);
    await c.query('reset role');
    await c.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, active) values ($1,$2,$3,true)`, [S5B.standLeader, FIX.childA1, FIX.parentA]);  // a parent_direct grant too
    // parent revokes the parent_direct grant (client update, origin='parent_direct')
    await c.query('set local role authenticated'); await be(c, FIX.parentA);
    await c.query(`update public.tutor_grants set active=false, revoked_at=now() where tutor_id=$1 and child_id=$2 and origin='parent_direct'`, [S5B.standLeader, FIX.childA1]);
    await be(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'union access: revoking parent_direct does NOT sever the active group_derived grant (leader keeps access via the group)');
  });
});

test('S5b-e: academy-path co-mint (background-checked staff); de-verify via clearance AND via membership removal', async () => {
  await seedS5b(db.client);
  // (academy branch) parentA (enrolled) adds childA1 to the academy-attached class led by the BACKGROUND-CHECKED staff
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.acadClass, FIX.childA1]);
    await drainAs(c, S3.staffCleared);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'academy branch: a background-checked staff leader (is_academy_staff) gains the work-view');
  });
  // (de-verify via CLEARANCE revoke) → the clearance trigger re-drives → grant revoked
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.acadClass, FIX.childA1]);
    await drainAs(c);
    await c.query('reset role');
    await c.query(`update public.academy_staff_clearances set revoked_at=now() where academy_group_id=$1 and actor_id=$2`, [S3.academyA, S3.staffCleared]);
    await c.query('set local role authenticated'); await be(c, S3.staffCleared);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'de-verify via background-check REVOKE → group_derived grant revoked (clearance re-driver)');
  });
  // (de-verify via ACADEMY MEMBERSHIP removal — SHOULD-FIX 1) → the memberships re-driver → grant revoked
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.acadClass, FIX.childA1]);
    await drainAs(c);
    await c.query('reset role');
    await c.query(`update public.memberships set active=false where group_id=$1 and member_actor_id=$2`, [S3.academyA, S3.staffCleared]);   // remove from academy staff
    await c.query('set local role authenticated'); await be(c, S3.staffCleared);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'SHOULD-FIX 1: removing the academy staff MEMBERSHIP revokes the lingering class work-grant (no linger)');
  });
});

test('S5b-f: SHOULD-FIX 2 — a delegated writer cannot place a child into a stranger’s class (no work-disclosure)', async () => {
  await seedS5b(db.client);
  // parentA delegates a WRITABLE grant to a tutor T1 (client-inserted parent_direct, can_write). T1 is NOT a leader of standClass.
  const t1 = '0000513b-0000-4000-8000-0000000000d1';
  await db.client.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, can_write, active) values ($1,$2,$3,true,true) on conflict do nothing`, [t1, FIX.childA1, FIX.parentA]);
  await as('authenticated', t1, async (c) => {
    // T1 (can_write via the grant, but NOT childA1's parent) tries to add childA1 into standClass (led by standLeader, a stranger)
    const r = (await c.query(`select public.join_group($1,$2,null,'member') r`, [S5B.standClass, FIX.childA1])).rows[0].r;
    assert.equal(r.error, 'not_authorized', 'a delegated writer canNOT add a child to a stranger’s class (is_my_child tightening) → no co-mint to a leader the parent never chose');
  });
  // sanity: the PARENT can still add their own child to that same stranger’s class (easy-in preserved)
  await as('authenticated', FIX.parentA, async (c) => {
    assert.equal((await c.query(`select public.join_group($1,$2,null,'member') r`, [S5B.standClass, FIX.childA1])).rows[0].r.ok, true, 'a PARENT adds their OWN child to any class/team (easy-in preserved)');
  });
});

// ============================================================================
// GROUP ENGINE · S6 — CAREFUL-OUT REMOVAL CEREMONY (0046). leave_group = parent 1-tap
// (is_my_child); remove_member = leader/academy documented (why-note + confirm + parent-notify
// + adult-scoped why-note); flag_member = a member flags for the leader. Removal = suppression,
// never deletion; the parent is the always-available safety valve. Reuses the S5b synchronous cut.
// ============================================================================
test('S6-a: parent 1-tap (no why-note, re-addable); leader remove requires why-note+confirm, recorded, parent-notified', async () => {
  await seedS5b(db.client);
  // (1) PARENT 1-taps removal of own child → leave_group, no why-note, grant cut, suppressed, re-addable
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await drainAs(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'precondition: the leader has the work-view');
    await be(c, FIX.parentA);
    assert.equal((await c.query(`select public.leave_group($1,$2,null) r`, [S5B.standClass, FIX.childA1])).rows[0].r.ok, true, 'parent 1-taps leave_group (no why-note)');
    await be(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'removal cut the grant synchronously');
    await c.query('reset role');
    assert.equal((await c.query(`select active from public.memberships where group_id=$1 and member_child_id=$2`, [S5B.standClass, FIX.childA1])).rows[0].active, false, 'membership SUPPRESSED (active=false, row persists) — not deleted');
    assert.equal((await c.query(`select count(*)::int n from public.membership_removals where member_child_id=$1`, [FIX.childA1])).rows[0].n, 0, 'a parent 1-tap writes NO why-note record');
    await c.query('set local role authenticated'); await be(c, FIX.parentA);
    assert.equal((await c.query(`select public.join_group($1,$2,null,'member') r`, [S5B.standClass, FIX.childA1])).rows[0].r.ok, true, 'parent re-adds (undo / safety valve)');
  });
  // (2) LEADER remove requires a why-note + confirm; recorded; parent-notified; re-addable
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await drainAs(c);
    await be(c, S5B.standLeader);
    assert.equal((await c.query(`select public.remove_member($1,$2,'') r`, [S5B.standClass, FIX.childA1])).rows[0].r.error, 'why_required', 'an EMPTY why-note is REJECTED (nothing changes)');
    await c.query('reset role');
    assert.equal((await c.query(`select active from public.memberships where group_id=$1 and member_child_id=$2`, [S5B.standClass, FIX.childA1])).rows[0].active, true, 'rejected removal: the membership is unchanged (still active)');
    await c.query('set local role authenticated'); await be(c, S5B.standLeader);
    assert.equal((await c.query(`select public.remove_member($1,$2,'disruptive behavior') r`, [S5B.standClass, FIX.childA1])).rows[0].r.ok, true, 'leader removes WITH a why-note → ok');
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, false, 'the leader’s grant is cut on removal');
    await c.query('reset role');
    assert.equal((await c.query(`select count(*)::int n from public.membership_removals where member_child_id=$1 and kind='removed' and note='disruptive behavior' and actor_id=$2`, [FIX.childA1, S5B.standLeader])).rows[0].n, 1, 'the why-note is RECORDED (accountability)');
    await c.query('set local role authenticated'); await be(c, FIX.parentA);
    assert.ok(await count(c, `select 1 from public.events where subject_child_id=$1 and group_id=$2 and payload->>'action'='removed'`, [FIX.childA1, S5B.standClass]) >= 1, 'the parent is NOTIFIED — reads the neutral removed event (DER-09)');
    assert.equal((await c.query(`select public.join_group($1,$2,null,'member') r`, [S5B.standClass, FIX.childA1])).rows[0].r.ok, true, 'PARENT-SUPREME: the parent re-adds (a non-parent can never permanently sever)');
  });
});

test('S6-b: authority boundaries — leader can’t 1-tap via leave_group; non-owner can’t remove; academy can', async () => {
  await seedS5b(db.client);
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    // a LEADER can NO LONGER 1-tap a child via leave_group (is_my_child only) — ceremony can’t be bypassed
    await be(c, S5B.standLeader);
    assert.equal((await c.query(`select public.leave_group($1,$2,null) r`, [S5B.standClass, FIX.childA1])).rows[0].r.error, 'not_authorized', 'a leader can NOT 1-tap a child via leave_group');
    // a non-owner / non-academy (parentB) canNOT remove_member
    await be(c, FIX.parentB);
    assert.equal((await c.query(`select public.remove_member($1,$2,'x') r`, [S5B.standClass, FIX.childA1])).rows[0].r.error, 'not_authorized', 'a non-owner / non-academy CANNOT remove (authority boundary)');
    // a leader canNOT remove from a group they do NOT lead
    await be(c, S5B.standLeader);
    assert.equal((await c.query(`select public.remove_member($1,$2,'x') r`, [S5B.unverClass, FIX.childA1])).rows[0].r.error, 'not_authorized', 'a leader cannot remove from a group they do NOT lead (cross-group border)');
  });
  // ACADEMY authority: the director removes a child from an academy class they don’t own (is_academy_staff)
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.acadClass, FIX.childA1]);
    await drainAs(c);
    await be(c, S3.director);
    assert.equal((await c.query(`select public.remove_member($1,$2,'academy policy') r`, [S5B.acadClass, FIX.childA1])).rows[0].r.ok, true, 'the ACADEMY (is_academy_staff of the group’s academy) removes from a group in their academy');
  });
});

test('S6-c: suppression-not-deletion; why-note adult-scoped (child can’t read); flag path; ref-count', async () => {
  await seedS5b(db.client);
  const coTutor = '0000513b-0000-4000-8000-0000000000e1';
  await db.client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S5B.standClass, coTutor]);
  // (suppression-not-deletion + why-note adult-scoped) leader removes childA1 (childA1 has a seeded attempt)
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await drainAs(c);
    await be(c, S5B.standLeader);
    await c.query(`select public.remove_member($1,$2,'secret reason')`, [S5B.standClass, FIX.childA1]);
    // the CHILD (own login) cannot read the why-note (P7); the parent + leader can
    await be(c, FIX.childA1Login);
    assert.equal(await count(c, `select 1 from public.membership_removals where member_child_id=$1`, [FIX.childA1]), 0, 'the CHILD canNOT read the why-note (P7 — adult-scoped)');
    await be(c, FIX.parentA);
    assert.equal(await count(c, `select 1 from public.membership_removals where member_child_id=$1 and note='secret reason'`, [FIX.childA1]), 1, 'the PARENT reads the why-note (accountability)');
    await be(c, S5B.standLeader);
    assert.equal(await count(c, `select 1 from public.membership_removals where member_child_id=$1`, [FIX.childA1]), 1, 'the group LEADER reads the why-note');
    // suppression-not-deletion: the honest record persists
    await c.query('reset role');
    assert.ok((await c.query(`select count(*)::int n from public.attempts where child_id=$1`, [FIX.childA1])).rows[0].n >= 1, 'suppression-not-deletion: the honest record (attempts) persists after removal');
  });
  // (flag path) a co-tutor (member, not the created_by owner) can’t remove → flags; the leader reads it
  await as('authenticated', coTutor, async (c) => {
    await c.query('reset role');
    await c.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true) on conflict do nothing`, [S5B.standClass, FIX.childA1]);
    await c.query('set local role authenticated'); await be(c, coTutor);
    assert.equal((await c.query(`select public.remove_member($1,$2,'x') r`, [S5B.standClass, FIX.childA1])).rows[0].r.error, 'not_authorized', 'a co-tutor (not the owner) cannot remove_member');
    assert.equal((await c.query(`select public.flag_member($1,$2,'wrong roster') r`, [S5B.standClass, FIX.childA1])).rows[0].r.ok, true, 'a co-tutor FLAGS the wrong member instead');
    await be(c, S5B.standLeader);
    assert.equal(await count(c, `select 1 from public.membership_removals where member_child_id=$1 and kind='flag' and note='wrong roster'`, [FIX.childA1]), 1, 'the flag surfaces to the group LEADER');
  });
  // (ref-count) removal from one of two classes → access retained via the other
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass2, FIX.childA1]);
    await drainAs(c, S5B.standLeader);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'two classes → work-view');
    await be(c, S5B.standLeader);
    await c.query(`select public.remove_member($1,$2,'left one class')`, [S5B.standClass, FIX.childA1]);
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'ref-count: removal from ONE class → access RETAINED via the other (S5b)');
  });
});

test('S6-d: SEC-03 folds — child can’t flag; whitespace-only why-note rejected; remove_member class/team-only; flag P7', async () => {
  await seedS5b(db.client);
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await drainAs(c);
    // (SHOULD-FIX 1) a CHILD actor cannot file a flag
    await be(c, FIX.childA1Login);
    assert.equal((await c.query(`select public.flag_member($1,$2,'x') r`, [S5B.standClass, FIX.childA1])).rows[0].r.error, 'not_authorized', 'a CHILD actor cannot file a flag (parent-in-the-loop)');
    // (SHOULD-FIX 3) a whitespace-only why-note is rejected
    await be(c, S5B.standLeader);
    assert.equal((await c.query(`select public.remove_member($1,$2,E'\t\n ') r`, [S5B.standClass, FIX.childA1])).rows[0].r.error, 'why_required', 'a whitespace-only why-note is REJECTED (accountability preserved)');
    await c.query('reset role');
    assert.equal((await c.query(`select active from public.memberships where group_id=$1 and member_child_id=$2`, [S5B.standClass, FIX.childA1])).rows[0].active, true, 'the whitespace-rejected removal changed nothing');
  });
  // (SHOULD-FIX 2) remove_member is class/team-only — the academy director cannot remove_member from the academy group
  await as('authenticated', S3.director, async (c) => {
    assert.equal((await c.query(`select public.remove_member($1,$2,'x') r`, [S3.academyA, FIX.childA1])).rows[0].r.error, 'bad_purpose', 'remove_member refuses a non-class/team group (parent-supreme: only where the parent can re-add)');
  });
  // (P7 flag) a flag note is also adult-scoped — the flagged child cannot read it (same policy as removed)
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await c.query('reset role');
    await c.query(`insert into public.membership_removals (kind, group_id, member_child_id, actor_id, note) values ('flag',$1,$2,$3,'flag secret')`, [S5B.standClass, FIX.childA1, S5B.standLeader]);
    await c.query('set local role authenticated'); await be(c, FIX.childA1Login);
    assert.equal(await count(c, `select 1 from public.membership_removals where member_child_id=$1 and kind='flag'`, [FIX.childA1]), 0, 'the flagged CHILD cannot read a flag note either (P7 — same policy)');
  });
});

// ============================================================================
// GROUP ENGINE · S7 — COCKPIT COMPOSITION (0047). Pure read composition: roster (is_group_leader)
// and work (can_view_child) as SEPARATE facets; every child-DATA cell re-asserts can_view_child
// (SF-1 aggregation-leak guard). Read-only; no policy change.
// ============================================================================
test('S7-a: coach cockpit — roster+work ONLY for grant-held (SF-1); non-consented EXCLUDED incl. academy name (F1)', async () => {
  await seedS5b(db.client);
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);   // consented → co-mint (verified leader)
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.unverClass, FIX.childA1]);   // consented but UNVERIFIED leader → NO grant (SF-1 grant-less)
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA3]);   // NON-consented (F1)
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.acadClass, FIX.childA3]);    // NON-consented, academy group (F1(b) name path)
    await c.query('reset role'); await c.query('select public.drain_derivations()'); await c.query('set local role authenticated');
    // granted consented child → roster + name + work
    await be(c, S5B.standLeader);
    const rS = (await c.query(`select child_id, nickname, has_work_access from public.coach_roster() where group_id=$1 and child_id=$2`, [S5B.standClass, FIX.childA1])).rows[0];
    assert.ok(rS && rS.has_work_access === true && rS.nickname, 'granted consented child → roster + work-access + name');
    // (F1) a NON-consented child is EXCLUDED from coach_roster (has_active_consent gate)
    assert.equal(await count(c, `select 1 from public.coach_roster() where group_id=$1 and child_id=$2`, [S5B.standClass, FIX.childA3]), 0, 'F1: a NON-consented child is EXCLUDED from coach_roster');
    const wS = (await c.query(`select child_id from public.coach_students_work() where group_id=$1`, [S5B.standClass])).rows.map(r => r.child_id);
    assert.ok(wS.includes(FIX.childA1) && !wS.includes(FIX.childA3), 'SF-1: work for the granted child; the non-consented child has 0 work');
    // (SF-1 grant-less) a CONSENTED rostered child under an UNVERIFIED leader → roster only (no work-access, no name)
    await be(c, S5B.unverLeader);
    const rU = (await c.query(`select nickname, has_work_access from public.coach_roster() where group_id=$1 and child_id=$2`, [S5B.unverClass, FIX.childA1])).rows[0];
    assert.ok(rU && rU.has_work_access === false && rU.nickname === null, 'SF-1: a consented rostered child under an UNVERIFIED leader → roster only (no work-access, no name)');
    assert.equal(await count(c, `select 1 from public.coach_students_work() where group_id=$1 and child_id=$2`, [S5B.unverClass, FIX.childA1]), 0, 'SF-1: the unverified leader gets 0 WORK for the rostered child');
    // (F1(b) academy name path) a non-consented child does NOT surface (name or id) to academy staff
    await be(c, S3.staffCleared);
    assert.equal(await count(c, `select 1 from public.coach_roster() where group_id=$1 and child_id=$2`, [S5B.acadClass, FIX.childA3]), 0, 'F1(b): a non-consented child does NOT surface to academy staff via coach_roster (name would else leak)');
    // cross-family: another family’s child is 0
    await be(c, S5B.standLeader);
    assert.equal(await count(c, `select 1 from public.coach_roster() where child_id=$1`, [FIX.childB1]), 0, 'cross-family: another family’s child is 0 in the coach cockpit');
  });
});

test('S7-b: parent-union — all + ONLY the parent’s own children across every group (bounded by is_my_child)', async () => {
  await seedS5b(db.client);
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass2, FIX.childA1]);
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA2]);
    const rows = (await c.query(`select distinct child_id, group_id from public.parent_union()`)).rows;
    const kids = new Set(rows.map(r => r.child_id)); const groups = new Set(rows.map(r => r.group_id));
    assert.ok(kids.has(FIX.childA1) && kids.has(FIX.childA2), 'parent-union rolls up ALL the parent’s children');
    assert.ok(!kids.has(FIX.childB1), 'parent-union NEVER includes another family’s child (bounded by is_my_child)');
    assert.ok(groups.has(S5B.standClass) && groups.has(S5B.standClass2), 'parent-union rolls up EVERY group each child is in (KER-3)');
  });
  // cross-family border: parentB’s union has childB1 (own) and NONE of family A
  await as('authenticated', FIX.parentB, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childB1]);
    const kids = new Set((await c.query(`select distinct child_id from public.parent_union()`)).rows.map(r => r.child_id));
    assert.ok(kids.has(FIX.childB1), 'parentB’s union shows their OWN child');
    assert.ok(!kids.has(FIX.childA1) && !kids.has(FIX.childA2), 'cross-family: parentB’s union excludes family A’s children');
  });
  // (F3) a granted TUTOR (can_view_child via a co-minted grant, but NOT is_my_child) gets 0 rows from parent_union
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.standClass, FIX.childA1]);
    await c.query('reset role'); await c.query('select public.drain_derivations()'); await c.query('set local role authenticated');
    await be(c, S5B.standLeader);   // now holds a group_derived grant for childA1
    assert.equal((await c.query('select public.can_view_child($1) v', [FIX.childA1])).rows[0].v, true, 'precondition: the tutor CAN view the child (grant)');
    assert.equal(await count(c, `select 1 from public.parent_union()`), 0, 'F3: a granted tutor gets 0 rows from parent_union (is_my_child is STRICTER than can_view_child)');
  });
});

test('S7-c: coach isolation (can’t see another coach’s team); cockpit-follows-role (lose the role → lose the view)', async () => {
  await seedS5b(db.client);
  // coach isolation: standLeader must NOT see unverLeader’s team
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`select public.join_group($1,$2,null,'member')`, [S5B.unverClass, FIX.childA1]);
    await be(c, S5B.standLeader);
    assert.equal(await count(c, `select 1 from public.coach_roster() where group_id=$1`, [S5B.unverClass]), 0, 'coach isolation: standLeader does NOT see another coach’s team roster');
    assert.equal(await count(c, `select 1 from public.coach_students_work() where group_id=$1`, [S5B.unverClass]), 0, 'coach isolation: standLeader sees 0 of another coach’s team work');
  });
  // cockpit-follows-role: a co-tutor leads standClass → sees it; deactivate their membership → the roster DISAPPEARS
  const coTutor = '0000513b-0000-4000-8000-0000000000e2';
  await db.client.query(`insert into public.memberships (group_id, member_child_id, role, active) values ($1,$2,'member',true) on conflict do nothing`, [S5B.standClass, FIX.childA1]);
  await db.client.query(`insert into public.memberships (group_id, member_actor_id, role, active) values ($1,$2,'tutor',true) on conflict do nothing`, [S5B.standClass, coTutor]);
  await as('authenticated', coTutor, async (c) => {
    assert.ok(await count(c, `select 1 from public.coach_roster() where group_id=$1 and child_id=$2`, [S5B.standClass, FIX.childA1]) >= 1, 'co-tutor (is_group_leader) composes a coach cockpit for their class');
  });
  await db.client.query(`update public.memberships set active=false where group_id=$1 and member_actor_id=$2`, [S5B.standClass, coTutor]);
  await as('authenticated', coTutor, async (c) => {
    assert.equal(await count(c, `select 1 from public.coach_roster() where group_id=$1`, [S5B.standClass]), 0, 'cockpit-follows-role: the co-tutor loses the leader role → the roster DISAPPEARS');
  });
});

// ============================================================================
// GROUP ENGINE · S8 — ACADEMY REDEEM REFACTOR (0048). redeem_invitation for a tutor/coach
// now ASSEMBLES a class/team GROUP via the engine (provision-once + an ENROLLMENT-AUTHORIZED
// child add) instead of a bespoke per-child parent_direct grant → the S7 roster + the S5b
// co-mint DERIVE, and academy-tutor WORK-access finally routes through the background-check
// gate (D1). Reuses seedAcademy: S3.academyA (director S3.director), S3.staffCleared (bg-checked),
// enrolled famA/famB. A FRESH unverified tutor uid (no clearance) proves roster-only. Redeems run
// inside a rolled-back as()-txn; the drain runs via drainAs (reset role → drain → authenticated).
// ============================================================================
const S8 = {
  unverTutor: '0000e1a5-0000-4000-8000-0000000000f1',
  revTutor:   '0000e1a5-0000-4000-8000-0000000000f2',   // holds a parent-REVOKED parent_direct grant (SF-1)
  sf2Leader:  '0000e1a5-0000-4000-8000-0000000000f3',    // a fresh academy leader for the bind-once constraint (SF-2)
};
const mintTutor = async (c, academy, child) =>
  (await c.query(`select public.mint_invitation($1,'tutor',$2,true,168) r`, [academy, child])).rows[0].r.code;

// S8-a — VERIFIED tutor redeem: class auto-provisions (org-scoped) + tutor is LEADER + coach_roster
// shows the enrolled child immediately (roster ≠ work); the drain CO-MINTS the group_derived
// work-grant (attributed to the parent) → coach_students_work + can_view_child. Grant is SCOPED.
test('S8-a: verified tutor redeem → class provisions + leader + roster; the drain co-mints the work-grant (D1)', async () => {
  await seedAcademy(db.client);
  await as('authenticated', S3.director, async (c) => {
    const code = await mintTutor(c, S3.academyA, FIX.childA1);      // mint as the director
    await be(c, S3.staffCleared);                                    // redeem as the VERIFIED (bg-checked) tutor
    const red = (await c.query(`select public.redeem_invitation($1) r`, [code])).rows[0].r;
    assert.ok(red.ok && red.kind === 'tutor' && red.class_id, `verified tutor redeems → class provisioned: ${JSON.stringify(red)}`);
    const cls = red.class_id;
    // the provisioned group is an ACADEMY-scoped class (org_id) → is_leader_verified takes the academy branch
    const g = (await c.query(`select purpose::text p, org_id, created_by from public.groups where id=$1`, [cls])).rows[0];
    assert.ok(g.p === 'class' && g.org_id === S3.academyA, 'the provisioned group is a class carrying org_id=academy');
    // the tutor is the LEADER; the S7 roster lights up BEFORE any drain (roster ≠ work)
    assert.equal((await c.query(`select public.is_group_leader($1,$2) v`, [cls, S3.staffCleared])).rows[0].v, true, 'the tutor is the class leader (is_group_leader)');
    assert.ok(await count(c, `select 1 from public.coach_roster() where group_id=$1 and child_id=$2`, [cls, FIX.childA1]) >= 1, 'coach_roster shows the enrolled child (roster facet)');
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA1])).rows[0].v, false, 'pre-drain: no work-grant yet (co-mint fires on the drain, like every join)');
    // drain → co-mint (verified leader)
    await drainAs(c, S3.staffCleared);
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA1])).rows[0].v, true, 'post-drain: the verified tutor CO-MINTS a group_derived work-grant → can_view_child');
    const grant = (await c.query(`select origin, origin_group_id, granted_by, active from public.tutor_grants where tutor_id=$1 and child_id=$2 and origin='group_derived'`, [S3.staffCleared, FIX.childA1])).rows[0];
    assert.ok(grant && grant.active && grant.origin_group_id === cls && grant.granted_by === FIX.parentA, 'the grant is group_derived, active, scoped to the class, attributed to the enrolled parent (transparency)');
    assert.ok(await count(c, `select 1 from public.coach_students_work() where group_id=$1 and child_id=$2`, [cls, FIX.childA1]) >= 1, 'coach_students_work shows the child (work facet)');
    // SCOPED: a NON-invited enrolled sibling (childA2, consented, same academy) is NOT in the cockpit
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA2])).rows[0].v, false, 'scoped: a non-invited enrolled sibling is NOT viewable (grant is per invited+enrolled child)');
    assert.equal(await count(c, `select 1 from public.coach_roster() where child_id=$1`, [FIX.childA2]), 0, 'scoped: the non-invited sibling is not on the roster');
  });
});

// S8-b — D1 (the security win): an UNVERIFIED tutor gets ROSTER-ONLY, no work (background-check
// gate governs). Plus BIND-ONCE idempotency (two keys → one class) and the enrollment-CONSENT gate.
test('S8-b: unverified tutor → roster only (D1 bg-check gate); bind-once; a non-consented child stays invisible', async () => {
  await seedAcademy(db.client);

  // ---- UNVERIFIED tutor (fresh uid, NO clearance): redeem → roster, but co-mint does NOT fire ----
  await as('authenticated', S3.director, async (c) => {
    const code1 = await mintTutor(c, S3.academyA, FIX.childA1);
    await be(c, S8.unverTutor);
    const red = (await c.query(`select public.redeem_invitation($1) r`, [code1])).rows[0].r;
    assert.ok(red.ok && red.class_id, 'an unverified tutor still redeems (roster path)');
    const cls = red.class_id;
    await drainAs(c, S8.unverTutor);
    assert.ok(await count(c, `select 1 from public.coach_roster() where group_id=$1 and child_id=$2`, [cls, FIX.childA1]) >= 1, 'D1: the UNVERIFIED tutor sees the child on the ROSTER');
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA1])).rows[0].v, false, 'D1: but NO work-grant (is_leader_verified=false — no completed background check)');
    assert.equal(await count(c, `select 1 from public.coach_students_work() where group_id=$1`, [cls]), 0, 'D1: coach_students_work is EMPTY for the unverified tutor');
    assert.equal((await c.query(`select has_work_access from public.coach_roster() where group_id=$1 and child_id=$2`, [cls, FIX.childA1])).rows[0].has_work_access, false, 'D1: the roster row reports has_work_access=false');
  });

  // ---- BIND-ONCE: the VERIFIED tutor redeems TWO keys (childA1 + childB1, different families) → ONE class ----
  await as('authenticated', S3.director, async (c) => {
    const kA = await mintTutor(c, S3.academyA, FIX.childA1);
    const kB = await mintTutor(c, S3.academyA, FIX.childB1);
    await be(c, S3.staffCleared);
    const r1 = (await c.query(`select public.redeem_invitation($1) r`, [kA])).rows[0].r;
    const r2 = (await c.query(`select public.redeem_invitation($1) r`, [kB])).rows[0].r;
    assert.ok(r1.ok && r2.ok && r1.class_id === r2.class_id, 'bind-once: both redeems resolve to the SAME class (no double-provision)');
    assert.equal((await c.query(`select count(*)::int n from public.groups where org_id=$1 and created_by=$2 and purpose='class'`, [S3.academyA, S3.staffCleared])).rows[0].n, 1, 'bind-once: exactly ONE class exists for (academy, tutor, class)');
    await drainAs(c, S3.staffCleared);
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA1])).rows[0].v, true, 'bind-once: childA1 (family A) co-minted');
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childB1])).rows[0].v, true, 'bind-once: childB1 (family B) co-minted — one class spanning two families, each enrollment-authorized');
    assert.equal((await c.query(`select count(distinct child_id)::int n from public.coach_students_work() where group_id=$1`, [r1.class_id])).rows[0].n, 2, 'both children appear in the work facet');
  });

  // ---- ENROLLMENT-CONSENT: a NON-consented enrolled child (childA3) never surfaces (roster or work) ----
  await as('authenticated', S3.director, async (c) => {
    const k3 = await mintTutor(c, S3.academyA, FIX.childA3);
    await be(c, S3.staffCleared);
    const r3 = (await c.query(`select public.redeem_invitation($1) r`, [k3])).rows[0].r;
    assert.ok(r3.ok, 'redeem for a non-consented but ENROLLED child succeeds (enrollment predicate holds)');
    await drainAs(c, S3.staffCleared);
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA3])).rows[0].v, false, 'consent gate: NO work-grant for a non-consented child (drain HELD + reconcile consent gate)');
    assert.equal(await count(c, `select 1 from public.coach_roster() where child_id=$1`, [FIX.childA3]), 0, 'consent gate: a non-consented child is EXCLUDED from the roster (has_active_consent, F1)');
  });
});

// S8-c — cross-academy border; parent transparency; remove-from-class revocation (S6 sync cut) +
// the careful-out re-redeem guard (a parent-removed child is never silently re-added).
test('S8-c: cross-academy border; parent transparency; remove-from-class revokes + careful-out re-redeem', async () => {
  await seedAcademy(db.client);

  // ---- CROSS-ACADEMY BORDER: an Academy B key for a child enrolled ONLY in Academy A → refused ----
  await as('authenticated', S3.directorB, async (c) => {
    const codeB = await mintTutor(c, S3.academyB, FIX.childA1);      // childA1 is enrolled in A, NOT B
    await be(c, S3.staffB);
    const red = (await c.query(`select public.redeem_invitation($1) r`, [codeB])).rows[0].r;
    assert.ok(red.ok === false && red.error === 'child_not_enrolled', 'cross-academy: a child not enrolled in THIS academy is refused (enrollment predicate keyed on academy_id)');
    assert.equal(await count(c, `select 1 from public.memberships m join public.groups g on g.id=m.group_id where g.org_id=$1 and m.member_child_id=$2`, [S3.academyB, FIX.childA1]), 0, 'cross-academy: NO class membership was created in Academy B');
    await drainAs(c, S3.staffB);
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA1])).rows[0].v, false, 'cross-academy: Academy B staff gets NO work-access to a family-A child');
  });

  // ---- TRANSPARENCY + REMOVE-FROM-CLASS REVOCATION + CAREFUL-OUT ----
  await as('authenticated', S3.director, async (c) => {
    const code = await mintTutor(c, S3.academyA, FIX.childA1);
    await be(c, S3.staffCleared);
    const cls = (await c.query(`select public.redeem_invitation($1) r`, [code])).rows[0].r.class_id;
    await drainAs(c);
    // TRANSPARENCY: the enrolled PARENT sees who has access (granted_by=parent → tutor_grants_select)
    await be(c, FIX.parentA);
    assert.ok(await count(c, `select 1 from public.tutor_grants where tutor_id=$1 and child_id=$2 and origin='group_derived' and active`, [S3.staffCleared, FIX.childA1]) >= 1, 'transparency: the parent sees the co-minted grant (granted_by=parent)');
    // REMOVE-FROM-CLASS: the parent removes their own child → S6 SYNCHRONOUS cut revokes the work-grant
    const lr = (await c.query(`select public.leave_group($1,$2,null) r`, [cls, FIX.childA1])).rows[0].r;
    assert.ok(lr.ok, 'the parent removes their child from the class (leave_group, is_my_child)');
    await be(c, S3.staffCleared);
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA1])).rows[0].v, false, 'remove-from-class: the work-grant is CUT synchronously (D2 / S6)');
    // CAREFUL-OUT: re-redeeming a FRESH key does NOT silently re-add the parent-removed child
    await be(c, S3.director);
    const code2 = await mintTutor(c, S3.academyA, FIX.childA1);
    await be(c, S3.staffCleared);
    const re = (await c.query(`select public.redeem_invitation($1) r`, [code2])).rows[0].r;
    assert.ok(re.ok === false && re.error === 'removed_from_class', 'careful-out: re-redeem does NOT silently re-add a parent-removed child');
    await drainAs(c, S3.staffCleared);
    assert.equal((await c.query(`select public.can_view_child($1) v`, [FIX.childA1])).rows[0].v, false, 'careful-out: the grant stays revoked (re-add is the parent’s explicit S6 action)');
  });
});

// S8-d — the two folded SEC-03 SHOULD-FIX guards:
//   SF-1: a parent's revocation of a DIRECT grant blocks an Academy re-mint (parent-supreme careful-out).
//   SF-2: bind-once is a real DB CONSTRAINT (a partial unique index), not just an application SELECT.
test('S8-d: SF-1 parent revocation blocks a re-mint; SF-2 bind-once is enforced by a unique index', async () => {
  await seedAcademy(db.client);

  // ---- SF-1: parentA revokes a parent_direct grant to a tutor → the Academy cannot silently re-grant ----
  await as('authenticated', FIX.parentA, async (c) => {
    await c.query(`insert into public.tutor_grants (tutor_id, child_id, granted_by, can_write, active, origin) values ($1,$2,$3,true,true,'parent_direct')`, [S8.revTutor, FIX.childA1, FIX.parentA]);
    await c.query(`update public.tutor_grants set active=false, revoked_at=now() where tutor_id=$1 and child_id=$2 and origin='parent_direct'`, [S8.revTutor, FIX.childA1]);
    await be(c, S3.director);
    const code = await mintTutor(c, S3.academyA, FIX.childA1);
    await be(c, S8.revTutor);
    const red = (await c.query(`select public.redeem_invitation($1) r`, [code])).rows[0].r;
    assert.ok(red.ok === false && red.error === 'revoked_by_parent', 'SF-1: a parent-revoked direct grant blocks the Academy re-mint (revoked_by_parent)');
    assert.equal(await count(c, `select 1 from public.memberships m join public.groups g on g.id=m.group_id where g.org_id=$1 and g.created_by=$2 and m.member_child_id=$3`, [S3.academyA, S8.revTutor, FIX.childA1]), 0, 'SF-1: the guard returns BEFORE any write (no class membership committed)');
  });

  // ---- SF-2: the (org_id, created_by, purpose) partial unique index rejects a duplicate academy class ----
  await db.client.query(`insert into public.groups (purpose,name,org_id,created_by) values ('class','SF2-A',$1,$2)`, [S3.academyA, S8.sf2Leader]);
  await assert.rejects(
    db.client.query(`insert into public.groups (purpose,name,org_id,created_by) values ('class','SF2-B',$1,$2)`, [S3.academyA, S8.sf2Leader]),
    /duplicate key|unique/i,
    'SF-2: a second academy class for the same (org, leader, purpose) is rejected by groups_academy_class_uniq');
  // a STANDALONE class (org_id NULL) by the same leader is unaffected (the index is partial)
  await db.client.query(`insert into public.groups (purpose,name,created_by) values ('class','SF2-standalone',$1)`, [S8.sf2Leader]);
  await db.client.query(`insert into public.groups (purpose,name,created_by) values ('class','SF2-standalone-2',$1)`, [S8.sf2Leader]);
});
