// ============================================================================
// dev-apply.mjs — apply the exact tested schema chain (FILES_M3: players stub +
// 0001..0012 + skills seed) to the DEV staging project. DEV-ONLY: guards the DEV
// ref and HARD-REFUSES prod. Resets public (DEV is synthetic + disposable, 0
// real users) so DEV matches the locally-proven schema exactly, then reconciles
// the migration-history table. Same cluster as the DEV-pinned Supabase MCP
// (verified by matching system_identifier). Run: node db/scripts/dev-apply.mjs
// ============================================================================
import pg from 'pg'
import { assertDevRef, PROD_REF } from './dev-config.mjs'
import { applySchema, FILES_M3 } from './local-stack.mjs'

const dbUrl = process.env.DEV_SUPABASE_DB_URL
assertDevRef(dbUrl)
if (dbUrl.includes(PROD_REF)) throw new Error('REFUSING: prod ref present in DB URL.')

console.log('Applying FILES_M3 (0001..0012 + stubs + skills) to DEV…')
await applySchema(dbUrl, FILES_M3) // drop public + apply the tested chain + pgrst reload

const c = new pg.Client({ connectionString: dbUrl }); await c.connect()
try {
  // reconcile: drop the stale phase-2 history rows (their objects were replaced)
  await c.query(`delete from supabase_migrations.schema_migrations where name in ('0000_players_stub','0001_mastery','0002_prod_rpcs_mirror')`)
  const t = (await c.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n
  const s = (await c.query('select count(*)::int n from public.skills')).rows[0].n
  const rls = (await c.query("select count(*)::int n from pg_tables where schemaname='public' and rowsecurity=false and tablename not in ('players','skills')")).rows[0].n
  console.log(`DEV schema applied: public tables=${t}, skills=${s}, non-RLS child-tables=${rls} (want 0)`)
} finally { await c.end() }
