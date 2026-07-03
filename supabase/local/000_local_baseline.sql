-- ============================================================================
-- 000_local_baseline.sql — LOCAL / EPHEMERAL DATABASES ONLY. NEVER RUN IN PROD.
-- ============================================================================
-- Recreates just enough of the EXISTING production environment for the
-- migrations and the RLS leak test to run against a throwaway Postgres:
--   1. The Supabase roles (anon / authenticated / service_role) and the
--      auth.uid() function, implemented exactly like Supabase (verified JWT
--      `sub` claim via request.jwt.* settings — never user_metadata).
--   2. A mirror of the CURRENT production `players` table (provided by the
--      owner on 2026-07-03). The real table is never touched; this mirror only
--      satisfies the children.legacy_player_id foreign key locally.
-- The migration runner applies this file only when --local is passed AND the
-- target is not a supabase.co host (see db/scripts/lib.mjs prod guard).
-- ============================================================================

-- ---- Supabase-equivalent extensions layout (pgcrypto lives in `extensions`) ----
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---- Supabase-equivalent roles ----
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;  -- mirrors Supabase: service key bypasses RLS
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ---- auth.uid() exactly as Supabase defines it (reads the VERIFIED jwt sub) ----
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
    ), ''
  )::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- ---- Mirror of the EXISTING production players table (structure only) ----
-- Production: players + SECURITY DEFINER RPCs signup_or_login / submit_score /
-- get_leaderboard, callable with the publishable key. Do not modify in prod.
create table public.players (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  pin_hash      text,
  best_score    int,
  best_stage    text,
  best_grade    text,
  ship_color    int,
  games_played  int,
  total_correct int,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
