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
]

export async function applySchema(dbUrl, files = FILES) {
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
