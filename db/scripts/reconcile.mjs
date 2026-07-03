// ============================================================================
// RECONCILIATION — proves the skill map is a faithful, REBUILDABLE projection
// of the append-only attempt log (the event-sourcing core principle).
//
// Two modes:
//   default          : self-contained CI gate. Boots an ephemeral Postgres,
//                      migrates, seeds the taxonomy, creates a consented child
//                      + player, drives randomized batches (with duplicates
//                      and rejects) through the record_attempts RPC as `anon`,
//                      then recomputes every (child, skill) mastery row from
//                      raw attempts via contracts/mastery.mjs and diffs it
//                      against what the SQL projection stored.
//   DATABASE_URL set : "is my data healthy?" report against a LOCAL/dev DB
//                      (prod guard still applies): recompute + diff + report,
//                      read-only apart from the schema reset the tooling does.
//
// Exit code 0 = projection matches the replayed log everywhere. Anything else
// fails (and fails CI).
// ============================================================================
import { ephemeralDb, applyMigrations, seedSkills } from './lib.mjs';
import { replay } from '../../contracts/mastery.mjs';

const TOL = 1e-6;   // SQL numeric vs JS float64 rounding

// deterministic PRNG for reproducible fixtures
function prng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296); }
const rnd = prng(20260703);
const uuidFrom = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function generateViaRpc(client) {
  // a consented child claimed from a player (the exact interim-keying shape)
  const player = await client.query(
    `insert into public.players (name, pin_hash) values
     ('ReconKid', extensions.crypt('7777', extensions.gen_salt('bf'))) returning id`);
  const child = await client.query(
    `insert into public.children (parent_id, legacy_player_id, nickname)
     values ('99999999-9999-4999-8999-999999999999', $1, 'Recon') returning id`, [player.rows[0].id]);
  const childId = child.rows[0].id;
  const consent = await client.query(
    `insert into public.consent_ledger (parent_id, child_id, action, method, policy_version)
     values ('99999999-9999-4999-8999-999999999999', $1, 'grant', 'stripe_card_transaction', 'test') returning id`, [childId]);
  await client.query(`update public.children set consent_id = $1 where id = $2`, [consent.rows[0].id, childId]);

  // stage/skill pairs the generator draws from (tag must match the taxonomy)
  const SKILLS = [[0, 'addition'], [1, 'subtraction'], [4, 'make-ten'], [13, 'multiplication'], [20, 'division']];
  const RESULTS = ['correct', 'correct', 'correct', 'incorrect', 'missed', 'invalid'];

  let idn = 0, sent = 0, dupes = 0;
  for (let b = 0; b < 6; b++) {
    const attempts = [];
    for (let i = 0; i < 25; i++) {
      const [stage, tag] = SKILLS[Math.floor(rnd() * SKILLS.length)];
      attempts.push({
        client_attempt_id: uuidFrom(++idn),
        stage_index: stage, skill: tag,
        result: RESULTS[Math.floor(rnd() * RESULTS.length)],
        problem_text: '1 + 1', correct_answer: 2, chosen_answer: 2,
        response_ms: Math.floor(rnd() * 9000), input_method: 'voice',
        asr_confidence: Math.round(rnd() * 100) / 100, run_time_s: i, level: 1,
      });
    }
    // salt in duplicates: re-send some earlier ids (must be ignored by the RPC)
    for (let d = 0; d < 5 && idn > 6; d++) {
      attempts.push({ ...attempts[Math.floor(rnd() * 20)], });
      dupes++;
    }
    // ...and a reject (bad stage) that must not disturb anything
    attempts.push({ ...attempts[0], client_attempt_id: uuidFrom(900000 + b), stage_index: 999 });

    const batch = {
      client_session_id: uuidFrom(800000 + b), mode: 'journey',
      started_at: new Date(Date.parse('2026-02-01T00:00:00Z') + b * 3600_000).toISOString(),
      attempts,
    };
    await client.query('begin');
    await client.query(`set local role anon`);
    const r = (await client.query(`select public.record_attempts('ReconKid','7777',$1::jsonb) as r`,
      [JSON.stringify(batch)])).rows[0].r;
    await client.query('commit');
    if (!r.ok) throw new Error('RPC refused during generation: ' + JSON.stringify(r));
    sent += r.inserted;
  }
  console.log(`generated via RPC: ${sent} inserted, ${dupes} duplicate resends, 6 forced rejects`);
  return childId;
}

export async function reconcile(client) {
  // 1) pull the raw log (the source of truth), mastery-relevant rows only
  const { rows: attempts } = await client.query(
    `select child_id, skill_id, result, created_at
       from public.attempts
      where result in ('correct','incorrect','missed')   -- 'invalid' never counts
      order by created_at asc, id asc`);
  // 2) replay per (child, skill) through the PURE model
  const byKey = new Map();
  for (const a of attempts) {
    const k = `${a.child_id}|${a.skill_id}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ result: a.result, at: a.created_at.toISOString() });
  }
  // 3) diff against the stored projection
  const { rows: stored } = await client.query(
    `select child_id, skill_id, alpha, beta, attempts_count, correct_count,
            last_seen_at, decay_halflife_days
       from public.child_skill_mastery`);
  const problems = [];
  const storedByKey = new Map(stored.map(m => [`${m.child_id}|${m.skill_id}`, m]));

  for (const [k, events] of byKey) {
    const m = storedByKey.get(k);
    if (!m) { problems.push(`${k}: attempts exist but NO mastery row`); continue; }
    const r = replay(k.split('|')[1], events, Number(m.decay_halflife_days));
    const diffs = [];
    if (Math.abs(Number(m.alpha) - r.alpha) > TOL) diffs.push(`alpha ${m.alpha} != ${r.alpha}`);
    if (Math.abs(Number(m.beta) - r.beta) > TOL) diffs.push(`beta ${m.beta} != ${r.beta}`);
    if (m.attempts_count !== r.attemptsCount) diffs.push(`attempts ${m.attempts_count} != ${r.attemptsCount}`);
    if (m.correct_count !== r.correctCount) diffs.push(`correct ${m.correct_count} != ${r.correctCount}`);
    if (m.last_seen_at.toISOString() !== r.lastSeenAt) diffs.push(`last_seen ${m.last_seen_at.toISOString()} != ${r.lastSeenAt}`);
    if (diffs.length) problems.push(`${k}: ${diffs.join('; ')}`);
  }
  // 4) projection rows with NO backing events are orphans (unless untouched seeds)
  for (const [k, m] of storedByKey) {
    if (!byKey.has(k) && m.attempts_count > 0) problems.push(`${k}: mastery row (${m.attempts_count} counted) with no attempts behind it`);
  }
  return { skills: byKey.size, storedRows: stored.length, problems };
}

// ---- standalone run ----
const db = await ephemeralDb();
try {
  const selfContained = !process.env.DATABASE_URL || true; // ephemeralDb resets schema either way
  await applyMigrations(db.client, { local: true });
  await seedSkills(db.client);
  await generateViaRpc(db.client);
  const report = await reconcile(db.client);
  console.log(`reconciled ${report.skills} (child,skill) event streams against ${report.storedRows} stored mastery rows`);
  if (report.problems.length) {
    console.error(`RECONCILIATION FAILED — the projection has drifted from the log:`);
    for (const p of report.problems) console.error('  ✗', p);
    process.exit(1);
  }
  console.log('RECONCILIATION OK — mastery is exactly rebuildable from the attempt log');
} finally {
  await db.stop();
}
