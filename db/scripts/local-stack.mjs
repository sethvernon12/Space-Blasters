// Applies the schema to the LOCAL Supabase stack (supabase start) in the correct
// order: local players stub -> 0001 -> 0002 -> fresh capture seed. LOCAL ONLY —
// refuses any non-localhost DB host. Config comes from `supabase status -o env`
// (DB_URL / API_URL / ANON_KEY) passed through the environment.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pgpkg from 'pg'

const { Client } = pgpkg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function stackConfig() {
  const dbUrl = process.env.DB_URL || ''
  const apiUrl = (process.env.API_URL || '').replace(/\/$/, '')
  const anonKey = process.env.ANON_KEY || ''
  if (!dbUrl || !apiUrl || !anonKey) {
    throw new Error('Missing DB_URL / API_URL / ANON_KEY — source them from `supabase status -o env` (local stack).')
  }
  for (const u of [dbUrl, apiUrl]) {
    let host
    try { host = new URL(u).hostname } catch { throw new Error(`Unparseable URL: ${u}`) }
    if (!LOCAL_HOSTS.has(host)) throw new Error(`REFUSING non-local host "${host}" — this tooling only ever targets a local stack.`)
  }
  return { dbUrl, restUrl: apiUrl + '/rest/v1', anonKey }
}

const FILES = [
  'supabase/local/001_players_stub.sql',      // local-only: players + pgcrypto
  'supabase/migrations/0001_mastery.sql',      // the reviewed mastery schema
  'supabase/migrations/0002_attempt_context.sql', // context escape hatch (pending re-review)
  'supabase/local/002_capture_seed.sql',       // fresh, aligned data-only seed
]

// Milestone-3 schema (accounts era): no name/PIN capture seed — the family is
// seeded in JS after GoTrue users are minted. 0003 pending re-review before DEV.
export const FILES_M3 = [
  'supabase/local/001_players_stub.sql',
  'supabase/migrations/0001_mastery.sql',
  'supabase/local/003_skills_seed.sql',        // taxonomy (reference data)
  'supabase/migrations/0002_attempt_context.sql',
  'supabase/migrations/0003_accounts.sql',
  'supabase/migrations/0004_teaching.sql',
  'supabase/migrations/0005_secure_yard.sql',
  'supabase/migrations/0006_hardening.sql',
  'supabase/migrations/0007_groups.sql',
  'supabase/migrations/0008_derivation_engine.sql',
  'supabase/migrations/0009_grading.sql',
  'supabase/migrations/0010_assignment_gen.sql',
  'supabase/migrations/0011_review_hardening.sql',
  'supabase/migrations/0012_hardening2.sql',
  'supabase/migrations/0013_moderation_and_guards.sql',
  'supabase/migrations/0014_actor_identity.sql',
]

const DEV_REF = 'appplvbgyghlhrjcaagn'
const PROD_REF = 'oafovcrxdjoyaxsytyjg'

export async function applySchema(dbUrl, files = FILES) {
  // Defense-in-depth: this function DROPS public — refuse any target that isn't
  // localhost or the DEV ref, and HARD-REFUSE prod, regardless of caller guards.
  if (String(dbUrl).includes(PROD_REF)) throw new Error('applySchema REFUSES the prod ref — it drops the public schema.')
  let host
  try { host = new URL(dbUrl).hostname } catch { throw new Error('applySchema: unparseable DB URL') }
  if (!LOCAL_HOSTS.has(host) && !String(dbUrl).includes(DEV_REF)) {
    throw new Error(`applySchema only targets localhost or the DEV ref (got host "${host}").`)
  }
  const c = new Client({ connectionString: dbUrl })
  await c.connect()
  try {
    // clean slate for rerunnability — LOCAL disposable stack only
    await c.query(`drop schema if exists public cascade;
      create schema public;
      grant usage on schema public to anon, authenticated, service_role;
      grant all on schema public to postgres, service_role;`)
    for (const f of files) {
      await c.query(fs.readFileSync(path.join(root, f), 'utf8'))
    }
    // PostgREST caches the schema — tell it to reload so the new RPC is callable
    await c.query(`notify pgrst, 'reload schema'`)
  } finally {
    await c.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dbUrl } = stackConfig()
  await applySchema(dbUrl)
  console.log('applied to local stack: players stub + 0001 + 0002 + capture seed')
}
