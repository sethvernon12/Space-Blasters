// Apply the local baseline + all migrations to a LOCAL database.
//   DATABASE_URL set   -> apply to that database (prod guard enforced)
//   DATABASE_URL unset -> boot an ephemeral PostgreSQL, apply, verify, throw it away
//                         (proves the migration set applies cleanly end-to-end)
import { ephemeralDb, applyMigrations, seedSkills } from './lib.mjs';

const db = await ephemeralDb();
try {
  await applyMigrations(db.client, { local: true });
  const n = await seedSkills(db.client);
  console.log(`seeded    public.skills with ${n} skills from taxonomy/skills.json`);
  const { rows } = await db.client.query(
    `select count(*)::int as tables from pg_tables where schemaname = 'public'`
  );
  console.log(`OK — migrations applied cleanly (${rows[0].tables} public tables) on ${process.env.DATABASE_URL ? 'DATABASE_URL' : 'an ephemeral database'}`);
} finally {
  await db.stop();
}
