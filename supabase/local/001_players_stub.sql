-- ============================================================================
-- 001_players_stub.sql — LOCAL STACK ONLY. NOT a migration; NEVER applied to
-- DEV or PROD (both already have the real players table + game RPCs).
-- ============================================================================
-- The `players` table (name + PIN + game stats) is PROD scaffolding created
-- outside our migration set, but 0001's children.legacy_player_id FK and
-- record_attempts' PIN auth depend on it. This stub recreates just enough of
-- it (structure only, plus pgcrypto in `extensions`) so the migrations apply
-- and the recorder round-trips against a fresh local Supabase stack.
--
-- Applied by db/scripts/local-stack.mjs BEFORE the migrations. Idempotent.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.players (
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
