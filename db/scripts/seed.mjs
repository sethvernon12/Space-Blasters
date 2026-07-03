// Seed fixture data for local development: the skills taxonomy plus two demo
// families with children, consent rows, attempts and mastery state.
// LOCAL ONLY (prod guard in lib.mjs). Fixed UUIDs so tests/dev are repeatable.
import { ephemeralDb, applyMigrations, seedSkills } from './lib.mjs';

export const FIX = {
  parentA: '11111111-1111-4111-8111-111111111111',
  parentB: '22222222-2222-4222-8222-222222222222',
  childA1: 'aaaaaaa1-0000-4000-8000-0000000000a1',
  childA2: 'aaaaaaa2-0000-4000-8000-0000000000a2',
  childA3: 'aaaaaaa3-0000-4000-8000-0000000000a3', // NO consent row: data collection must be blocked
  childB1: 'bbbbbbb1-0000-4000-8000-0000000000b1',
  childA1Login: 'ccccccc1-0000-4000-8000-0000000000c1', // the child's own auth user
  legacyChild: 'dddddddd-0000-4000-8000-0000000000d1', // unclaimed legacy import
};

export async function seedFixtures(client) {
  // a legacy production-style players row (mirror table locally)
  const player = await client.query(
    `insert into public.players (name, best_score, best_stage, games_played, total_correct)
     values ('LegacyKid', 385, 'Add within 10', 12, 140) returning id`
  );

  // children: two for family A (one with its own child login), one for family B,
  // and one UNCLAIMED legacy child (parent_id NULL -> invisible to every client)
  await client.query(
    `insert into public.children (id, parent_id, auth_user_id, legacy_player_id, nickname, grade_band) values
     ($1, $2, $3, null, 'Nova', '1'),
     ($4, $2, null, null, 'Milo', 'K'),
     ($5, $2, null, null, 'Pip',  '2'),
     ($6, $7, null, null, 'Rex',  '3'),
     ($8, null, null, $9, 'LegacyKid', null)`,
    [FIX.childA1, FIX.parentA, FIX.childA1Login, FIX.childA2, FIX.childA3, FIX.childB1, FIX.parentB, FIX.legacyChild, player.rows[0].id]
  );

  // consent ledger (grant rows) + link back to children
  const consent = await client.query(
    `insert into public.consent_ledger (parent_id, child_id, action, method, policy_version) values
     ($1, $2, 'grant', 'stripe_card_transaction', 'privacy-draft-2026-07'),
     ($1, $3, 'grant', 'stripe_card_transaction', 'privacy-draft-2026-07'),
     ($4, $5, 'grant', 'stripe_card_transaction', 'privacy-draft-2026-07')
     returning id, child_id`,
    [FIX.parentA, FIX.childA1, FIX.childA2, FIX.parentB, FIX.childB1]
  );
  for (const row of consent.rows) {
    await client.query(`update public.children set consent_id = $1 where id = $2`, [row.id, row.child_id]);
  }

  // attempts shaped exactly like today's game events (see docs/DATA_MAP.md):
  // latency_ms NULL (game doesn't emit it yet), run_time_s = cumulative seconds
  await client.query(
    `insert into public.attempts
       (child_id, skill_id, module_id, client_attempt_id, result, problem_text,
        correct_answer, chosen_answer, latency_ms, run_time_s, level, stage_index, mode, model_version) values
     ($1, 'add5', 'space-blasters', gen_random_uuid(), 'correct',   '2 + 3', 5, 5,    null,  4.2, 1, 0, 'journey', 'mastery-v1'),
     ($1, 'sub5', 'space-blasters', gen_random_uuid(), 'incorrect', '4 − 2', 2, 3,    null, 15.1, 2, 1, 'journey', 'mastery-v1'),
     ($1, 'sub5', 'space-blasters', gen_random_uuid(), 'missed',    '5 − 1', 4, null, null, 27.8, 2, 1, 'journey', 'mastery-v1'),
     ($2, 'mult2','space-blasters', gen_random_uuid(), 'correct',   '2 × 7', 14, 14,  null,  9.9, 53, 13, 'expert', 'mastery-v1')`,
    [FIX.childA1, FIX.childB1]
  );

  // mastery rows (written by the service-side model worker in real life)
  await client.query(
    `insert into public.child_skill_mastery (child_id, skill_id, alpha, beta, last_seen_at, last_correct_at, model_version) values
     ($1, 'add5', 5, 2, now(), now(), 'mastery-v1'),
     ($1, 'sub5', 2, 3, now(), now(), 'mastery-v1'),
     ($2, 'mult2', 3, 1, now(), now(), 'mastery-v1')`,
    [FIX.childA1, FIX.childB1]
  );

  await client.query(
    `insert into public.child_skill_misconception
       (child_id, skill_id, misconception_id, evidence_count, last_evidence_at, model_version) values
     ($1, 'sub5', 'sub-counts-up-instead-of-back', 2, now(), 'mastery-v1')`,
    [FIX.childA1]
  );
}

// Run standalone: boot ephemeral (or DATABASE_URL) db, migrate, seed, report.
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await ephemeralDb();
  try {
    await applyMigrations(db.client, { local: true });
    const n = await seedSkills(db.client);
    await seedFixtures(db.client);
    const counts = await db.client.query(
      `select (select count(*) from public.children)::int as children,
              (select count(*) from public.attempts)::int as attempts,
              (select count(*) from public.child_skill_mastery)::int as mastery`
    );
    console.log(`OK — seeded ${n} skills +`, counts.rows[0]);
  } finally {
    await db.stop();
  }
}
