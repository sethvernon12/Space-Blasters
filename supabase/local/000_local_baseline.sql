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

-- ---- Minimal auth.users / auth.identities mocks (EPHEMERAL ONLY) ----
-- The full Supabase local stack provides the real auth schema; the throwaway leak-test
-- DB does not. Migrations that reference these at apply time (e.g. 0023's provider_id
-- lookup) or at runtime (0019 dormant join) need them to exist. Structure only.
create table if not exists auth.users (
  id              uuid primary key,
  email           text,
  last_sign_in_at timestamptz,
  created_at      timestamptz default now()
);
create table if not exists auth.identities (
  provider_id text not null,
  user_id     uuid not null,
  provider    text not null default 'google',
  created_at  timestamptz default now()
);

-- ---- Minimal storage.buckets / storage.objects mocks (EPHEMERAL ONLY) ----
-- The full local stack provides the storage schema; the throwaway DB does not. Phase-4
-- migrations insert a bucket (0024) and read the object catalog (0027 manifest).
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;
create table if not exists storage.buckets (
  id                text primary key,
  name              text,
  public            boolean default false,
  file_size_limit   bigint,
  allowed_mime_types text[],
  created_at        timestamptz default now()
);
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text,
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);

-- ---- Mirror of the Supabase-provided `supabase_realtime` publication (EPHEMERAL ONLY) ----
-- The full local stack provides this publication (platform-created, initially empty); migrations
-- add specific tables to it (e.g. 0028 → grade_proposals). Creating it here lets the isolation
-- matrix enforce "every live-streamed table FORCES RLS" — the Realtime delivery isolation invariant
-- (Postgres Changes only delivers rows a subscriber can SELECT; a client-side channel filter is not
-- a security boundary). Without this mirror, 0028's guarded ALTER silently no-ops (undefined_object).
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;   -- empty; migrations add tables explicitly
  end if;
end $$;

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
