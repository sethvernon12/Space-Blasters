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

test('no consent, no data: attempts for a consent-less child are rejected', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    await rejects(c, `insert into public.attempts (child_id, skill_id, client_attempt_id, result)
         values ($1, 'add5', gen_random_uuid(), 'correct')`,
      [FIX.childA3], /row-level security/i, 'childA3 has no consent_ledger link');
  });
});

test('cross-FAMILY reads return zero rows on every child-scoped table', async () => {
  await as('authenticated', FIX.parentB, async (c) => {
    assert.equal(await count(c, 'select 1 from public.children where id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.attempts where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.child_skill_mastery where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.child_skill_misconception where child_id = $1', [FIX.childA1]), 0);
    assert.equal(await count(c, 'select 1 from public.consent_ledger where child_id = $1', [FIX.childA1]), 0);
  });
});

test('cross-FAMILY write: parent B cannot insert attempts for child A', async () => {
  await as('authenticated', FIX.parentB, async (c) => {
    await rejects(c, `insert into public.attempts (child_id, skill_id, client_attempt_id, result)
         values ($1, 'add5', gen_random_uuid(), 'correct')`, [FIX.childA1], /row-level security/i);
  });
});

test('cross-CHILD, same family: a child login sees ONLY itself, not its sibling', async () => {
  await as('authenticated', FIX.childA1Login, async (c) => {
    const rows = (await c.query('select id from public.children')).rows.map(r => r.id);
    assert.deepEqual(rows, [FIX.childA1]);                     // sibling A2 invisible
    assert.equal(await count(c, 'select 1 from public.attempts where child_id = $1', [FIX.childA2]), 0);
    // can log its own attempt...
    await c.query(
      `insert into public.attempts (child_id, skill_id, client_attempt_id, result)
       values ($1, 'add5', gen_random_uuid(), 'correct')`, [FIX.childA1]);
    // ...but not the sibling's
    await rejects(c, `insert into public.attempts (child_id, skill_id, client_attempt_id, result)
         values ($1, 'add5', gen_random_uuid(), 'correct')`, [FIX.childA2], /row-level security/i);
  });
});

test('anon (the public game key) can touch nothing', async () => {
  for (const t of ['children', 'attempts', 'child_skill_mastery', 'child_skill_misconception', 'consent_ledger', 'skills']) {
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

test('skills taxonomy is readable by signed-in users and write-protected', async () => {
  await as('authenticated', FIX.parentA, async (c) => {
    const n = (await c.query('select count(*)::int as n from public.skills')).rows[0].n;
    assert.ok(n >= 23, 'expected the full 23-stage taxonomy');
    await rejects(c, `update public.skills set display_name = 'hacked' where id = 'add5'`, undefined, /permission denied/i);
  });
});
