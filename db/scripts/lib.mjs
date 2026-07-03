// Shared helpers for the LOCAL-ONLY database tooling.
// Hard rule: this tooling must never be able to touch a real Supabase database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// PROD GUARD — refuses anything that smells like a real Supabase database.
// Applying schema to any real DB (incl. staging) needs explicit human approval
// (CLAUDE.md NON-NEGOTIABLE #1), and happens via the Supabase dashboard/CLI —
// never through these scripts.
// ---------------------------------------------------------------------------
const BANNED = ['supabase.co', 'supabase.com', 'supabase.in', 'pooler.supabase', 'oafovcrxdjoyaxsytyjg'];
export function assertNotProd(url) {
  const u = String(url).toLowerCase();
  for (const b of BANNED) {
    if (u.includes(b)) {
      console.error(
        `\nREFUSING to connect: "${url}" looks like a real Supabase database.\n` +
        `This tooling only ever targets local/ephemeral Postgres. Applying schema to a\n` +
        `real database requires explicit human approval (see CLAUDE.md, NON-NEGOTIABLE #1).\n`
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Ephemeral database: uses DATABASE_URL if provided (e.g. CI's postgres service
// or a local docker container), otherwise boots a throwaway real PostgreSQL via
// the embedded-postgres dev-dependency (no Docker required).
// ---------------------------------------------------------------------------
export async function ephemeralDb() {
  const { default: pgpkg } = await import('pg');
  const { Client } = pgpkg;

  if (process.env.DATABASE_URL) {
    assertNotProd(process.env.DATABASE_URL);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return { client, url: process.env.DATABASE_URL, stop: () => client.end() };
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = path.join(root, 'db', `.pgdata-${process.pid}`);
  const port = 5544 + (process.pid % 400);
  const epg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await epg.initialise();
  await epg.start();
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  const client = new Client({ connectionString: url });
  await client.connect();
  return {
    client,
    url,
    stop: async () => {
      try { await client.end(); } catch {}
      try { await epg.stop(); } catch {}
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Migration runner: 000_local_baseline.sql (local mirrors of prod + Supabase
// roles/auth.uid) then supabase/migrations/*.sql in filename order, each in its
// own transaction. Forward-only; no down-migrations by design.
// ---------------------------------------------------------------------------
export async function applyMigrations(client, { local = true } = {}) {
  const files = [];
  if (local) files.push(path.join(root, 'supabase', 'local', '000_local_baseline.sql'));
  const migDir = path.join(root, 'supabase', 'migrations');
  for (const f of fs.readdirSync(migDir).sort()) {
    if (f.endsWith('.sql')) files.push(path.join(migDir, f));
  }
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('commit');
      console.log('applied  ', path.relative(root, file));
    } catch (err) {
      await client.query('rollback');
      console.error(`FAILED in ${path.relative(root, file)}:\n  ${err.message}`);
      throw err;
    }
  }
}

export function loadTaxonomy() {
  return JSON.parse(fs.readFileSync(path.join(root, 'taxonomy', 'skills.json'), 'utf8'));
}

// Seed public.skills straight from taxonomy/skills.json (idempotent).
export async function seedSkills(client) {
  const tax = loadTaxonomy();
  for (const s of tax.skills) {
    await client.query(
      `insert into public.skills
         (id, display_name, category, alt_categories, ccss_codes, ccss_gap, grade_band, position)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do nothing`,
      [s.id, s.name, s.category, s.altCategories, s.ccss, s.ccssGap, s.gradeBand, s.position]
    );
  }
  return tax.skills.length;
}

// Parse the REAL game code so taxonomy/DB can never silently drift from it.
export function parseGame() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const stagesBlock = html.match(/const STAGES = \[([\s\S]*?)\n  \];/);
  if (!stagesBlock) throw new Error('Could not locate the STAGES ladder in index.html');
  const stageKeys = [...stagesBlock[1].matchAll(/key:'([A-Za-z0-9]+)'/g)].map(m => m[1]);
  const skillTags = [...new Set([...html.matchAll(/skill:'([a-z0-9-]+)'/g)].map(m => m[1]))].sort();
  if (!stageKeys.length || !skillTags.length) throw new Error('Parsed empty stage/skill sets from index.html');
  return { stageKeys, skillTags };
}
