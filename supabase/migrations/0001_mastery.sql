-- ============================================================================
-- 0001_mastery.sql — Phase 0: LOCKED mastery / skill-map schema
-- ============================================================================
-- STATUS: NOT APPLIED ANYWHERE. Forward-only migration file; the repo's
-- migrations folder is the single source of truth for schema (CLAUDE.md
-- ARCHITECTURE). Applying this to ANY real database (including staging)
-- requires explicit human approval per CLAUDE.md NON-NEGOTIABLE #1.
--
-- Designed against what the game ACTUALLY emits today (read from index.html
-- on 2026-07-03):
--
--   recordAnswer(entry) -> game.log + window.onMathAnswer(evt), where evt =
--     {
--       text: '4 − 2',            -- problem as displayed (no PII)
--       correctAnswer: 2,         -- int
--       chosen: 3 | null,         -- null when the problem fell (missed)
--       correct: false,           -- boolean
--       missed: true,             -- present (true) ONLY on fall-through
--       level: 7,                 -- global curriculum level (int)
--       skill: 'subtraction',     -- one of 13 coarse tags (see taxonomy/skills.json)
--       stage: 'Subtract within 5',
--       stageIndex: 1,            -- index into the 23-entry STAGES ladder;
--                                 -- for review/preview problems this is the
--                                 -- PROBLEM's stage, not the player's — use it
--                                 -- (not the player level) for attribution
--       time: 27.8,               -- SECONDS SINCE RUN START (cumulative), NOT
--                                 -- per-problem latency
--       mode: 'journey',          -- journey|beginner|intermediate|advanced|expert
--       pilot: 'Nova'             -- display name; NEVER stored in attempts (PII rule)
--     }
--
-- Signals the mastery model wants that the game does NOT emit yet are present
-- as NULLABLE, not-yet-populated columns, each with a comment saying where the
-- data will come from.
--
-- ---------------------------------------------------------------------------
-- child_id KEYING ASSUMPTION (before parent accounts exist):
-- Today's production has only `players` (name + PIN, no parents, no auth.users).
-- ASSUMPTION for the Phase-3 migration: each legacy `players` row becomes ONE
-- `children` row (children.legacy_player_id -> players.id) owned by a
-- CLAIMABLE PLACEHOLDER PARENT (children.parent_id NULL until a real parent
-- signs in with Google and proves control of the legacy name+PIN, at which
-- point parent_id is set and a consent_ledger row is recorded). Until claimed:
-- parent_id IS NULL, auth_user_id IS NULL => NO RLS policy matches => the row
-- is INVISIBLE to every client (deny-by-default), reachable only by the
-- audited service path. Nothing in this file modifies or drops `players`.
-- ---------------------------------------------------------------------------
-- THREAT MODEL for the RLS in this file (deny-by-default, per CLAUDE.md HARD
-- RULES #2 and #10):
--   * Adversaries: (a) another family's authenticated parent/child probing
--     other children's data; (b) a sibling child probing another child in the
--     SAME family; (c) the anon/publishable key shipped inside the public game
--     (fully attacker-controlled); (d) a compromised/forged JWT claim in
--     user_metadata (users can edit their own user_metadata — NEVER key
--     security on it; we key ONLY on auth.uid(), which is the verified `sub`).
--   * Decisions: RLS ENABLED + FORCED on every table; zero GRANTs to anon —
--     the game's anon key can never reach these tables even if a policy bug
--     ships; parents see exactly their own children's rows; a child session
--     (auth_user_id) sees only itself; mastery/misconception rows are
--     READ-ONLY to all clients (written exclusively by the server-side model
--     worker); attempts are append-only (no UPDATE/DELETE policy + trigger);
--     consent_ledger is immutable (trigger blocks UPDATE/DELETE for every
--     role, INCLUDING service_role, since triggers fire regardless of RLS).
--   * Residual risk (accepted + mitigated in code): service_role BYPASSES RLS.
--     Every Edge Function using it MUST re-filter by child_id in code, and no
--     service key ever ships to a client (HARD RULES #2, #10).
-- ============================================================================

-- ============ skills — taxonomy anchor (mirrors taxonomy/skills.json) ============
-- skills.id is the STABLE slug and equals the game's STAGES key (e.g. 'add5').
-- Attribution rule: an incoming game event resolves skill_id via its
-- stageIndex -> skills.position (see docs/DATA_MAP.md), NOT via the coarse tag.
create table public.skills (
  id           text primary key,           -- = STAGES key, e.g. 'add5'
  display_name text not null,              -- = STAGES name, e.g. 'Add within 5'
  category     text not null,              -- the game's coarse `skill` tag, e.g. 'addition'
  alt_categories text[] not null default '{}', -- extra tags a stage can emit (mixMD emits multiplication AND division)
  ccss_codes   text[] not null default '{}',   -- Common Core codes; empty only if ccss_gap says why
  ccss_gap     text,                       -- non-null flags an imperfect/missing CCSS mapping
  grade_band   text,                       -- 'K'..'4' (guidance for reading level / timers)
  position     int  not null unique,       -- = index in the game's STAGES ladder
  created_at   timestamptz not null default now()
);

-- ============ children — the profile every child-scoped row keys on ============
create table public.children (
  id               uuid primary key default gen_random_uuid(),
  parent_id        uuid,          -- auth.users.id of the owning parent (Google login).
                                  -- NULL until Phase 3 claims/creates it. NEVER taken
                                  -- from user_metadata.
  auth_user_id     uuid unique,   -- the child's own auth.users.id if the child gets a
                                  -- login (Phase 3+); NULL otherwise.
  legacy_player_id uuid unique references public.players(id),
                                  -- Phase-3 migration links (never modifies) the
                                  -- existing production players row.
  nickname         text not null check (char_length(nickname) between 1 and 40),
                                  -- data minimization: nickname, never legal name (HARD RULE #6)
  grade_band       text,
  consent_id       uuid,          -- latest GRANT row in consent_ledger; a child row
                                  -- SHOULD NOT be created before consent except the
                                  -- Phase-3 legacy import (unclaimed rows are invisible
                                  -- to all clients). FK added below (circular ref).
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ============ consent_ledger — immutable Verifiable Parental Consent record ============
-- HARD RULE #1: no child profile stores data until VPC is recorded. Append-only:
-- revocation is a NEW row (action='revoke'), never an update.
create table public.consent_ledger (
  id             uuid primary key default gen_random_uuid(),
  parent_id      uuid not null,           -- auth.users.id of the consenting parent
  child_id       uuid not null references public.children(id),
  action         text not null check (action in ('grant','revoke')),
  method         text not null check (method in ('stripe_card_transaction','legacy_claim','other_vpc')),
                                           -- FTC-recognized VPC: the Stripe card transaction qualifies
  policy_version text not null,            -- privacy-policy version consented to
  detail         jsonb not null default '{}'::jsonb,  -- e.g. stripe payment_intent id (NEVER card data)
  created_at     timestamptz not null default now()
);
alter table public.children
  add constraint children_consent_fk foreign key (consent_id) references public.consent_ledger(id);

create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are append-only/immutable', tg_table_name;
end $$;

create trigger consent_ledger_immutable
  before update or delete on public.consent_ledger
  for each row execute function public.forbid_mutation();

-- ============ attempts — append-only event log (multi-game module contract) ============
-- One row per answered/missed problem. This is the recordAttempt() sink; games
-- NEVER write mastery directly. Schema is versioned via model_version +
-- module_id. NO PII: pilot/nickname deliberately absent.
create table public.attempts (
  id                uuid primary key default gen_random_uuid(),
  child_id          uuid not null references public.children(id) on delete cascade,
  skill_id          text not null references public.skills(id),
  module_id         text not null default 'space-blasters',
  client_attempt_id uuid not null,        -- idempotency key for the offline outbox
  result            text not null check (result in
                      ('correct','incorrect','missed','misconception','slip','guess')),
                    -- game today emits only correct / incorrect (wrong tap) / missed
                    -- (fell); 'misconception'/'slip'/'guess' start with Phase-2
                    -- classification of distractors + response patterns.
  misconception_id  text,                 -- NULL today; Phase 2 misconception-tagged
                                          -- distractors populate it.
  problem_text      text,                 -- evt.text, e.g. '4 − 2' (no PII)
  correct_answer    int,                  -- evt.correctAnswer
  chosen_answer     int,                  -- evt.chosen (NULL when missed)
  latency_ms        int,                  -- NULL today: the game emits evt.time =
                                          -- CUMULATIVE seconds since run start, not
                                          -- per-problem latency. Phase-1 follow-up adds
                                          -- per-problem latencyMs to the event.
  run_time_s        numeric,              -- evt.time as emitted today (cumulative)
  level             int,                  -- evt.level (global curriculum level)
  stage_index       int,                  -- evt.stageIndex (authoritative for skill_id)
  mode              text,                 -- evt.mode (journey|beginner|...|expert)
  model_version     text,
  created_at        timestamptz not null default now(),
  unique (child_id, client_attempt_id)
);
create index attempts_child_skill_idx on public.attempts (child_id, skill_id, created_at desc);

create trigger attempts_append_only
  before update or delete on public.attempts
  for each row execute function public.forbid_mutation();

-- ============ child_skill_mastery — per (child, skill) model state ============
-- LOCKED before Phase 2 logs anything (CLAUDE.md ARCHITECTURE). Written ONLY by
-- the server-side model worker; clients read.
create table public.child_skill_mastery (
  child_id  uuid not null references public.children(id) on delete cascade,
  skill_id  text not null references public.skills(id),

  -- Beta posterior over P(correct). Point estimate alpha/(alpha+beta); the
  -- 75–85% difficulty target and review scheduling use the UNCERTAINTY too.
  alpha     numeric not null default 1 check (alpha > 0),
  beta      numeric not null default 1 check (beta  > 0),
  mastery   numeric generated always as (alpha / (alpha + beta)) stored,
            -- convenience RAW point estimate; the model applies TIME-DECAY at
            -- read/update time from last_seen_at + decay_halflife_days (raw
            -- alpha/beta stay exact so decay parameters can be re-tuned).
  last_seen_at        timestamptz,
  last_correct_at     timestamptz,
  decay_halflife_days numeric not null default 30,
  model_version       text not null,

  -- "Mastered" gates on ALL of the signals below, never game accuracy alone.
  -- Every one is NULLABLE + not-yet-populated; source noted per column:
  fluency_latency_ms_median numeric,      -- from attempts.latency_ms (Phase-1 follow-up
                                          -- adds per-problem latency to the game event)
  fluency_trend             numeric,      -- Phase 2: latency slope across sessions
                                          -- (fluency = getting faster over sessions,
                                          -- never a within-question timer)
  retention_last_success_at timestamptz,  -- Phase 2: spaced re-test scheduler (~1d,3d,
                                          -- 1wk,3wk,monthly) writes on spaced success
  retention_strength        numeric,      -- Phase 2: spacing model state
  confidence                numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
                                          -- Phase 6/7: metacognition prompts (child
                                          -- predicts own accuracy)
  transfer_success_count    int,          -- Phase 5: handwritten/open-ended graded work
                                          -- (handwriting grading is the transfer check)
  transfer_last_success_at  timestamptz,  -- Phase 5

  updated_at timestamptz not null default now(),
  primary key (child_id, skill_id)
);

-- ============ child_skill_misconception — per-skill misconception state ============
-- Pedagogy: log answers as correct | misconception:<id> | slip | guess; work
-- targets the ACTIVE misconception. Misconception taxonomy ships with Phase-2
-- content; the table is locked now so the schema never shifts under logged data.
create table public.child_skill_misconception (
  child_id         uuid not null references public.children(id) on delete cascade,
  skill_id         text not null references public.skills(id),
  misconception_id text not null,          -- e.g. 'sub-swaps-operands' (Phase-2 taxonomy)
  evidence_count   int  not null default 0,
  last_evidence_at timestamptz,
  active           boolean not null default true,
  resolved_at      timestamptz,
  model_version    text,
  primary key (child_id, skill_id, misconception_id)
);

-- ============================================================================
-- ROW LEVEL SECURITY — deny-by-default, keyed to auth.uid() ONLY
-- ============================================================================
alter table public.skills                    enable row level security;
alter table public.children                  enable row level security;
alter table public.consent_ledger            enable row level security;
alter table public.attempts                  enable row level security;
alter table public.child_skill_mastery       enable row level security;
alter table public.child_skill_misconception enable row level security;

alter table public.skills                    force row level security;
alter table public.children                  force row level security;
alter table public.consent_ledger            force row level security;
alter table public.attempts                  force row level security;
alter table public.child_skill_mastery       force row level security;
alter table public.child_skill_misconception force row level security;

-- Ownership predicate: is this child mine (as parent) or me (as child login)?
-- SECURITY INVOKER on purpose: it runs under the caller's RLS, and the
-- children policies below use only direct column checks (no recursion).
create or replace function public.is_my_child(c uuid) returns boolean
language sql stable security invoker as $$
  select exists (
    select 1 from public.children ch
    where ch.id = c
      and (ch.parent_id = auth.uid() or ch.auth_user_id = auth.uid())
  )
$$;

-- skills: shared read-only reference data for signed-in users; writes are
-- migrations/service only (no client write policy).
create policy skills_read on public.skills
  for select to authenticated using (true);

-- children: a parent sees/edits own children; a child login sees itself.
-- Unclaimed legacy rows (both ids NULL) match no policy => invisible.
create policy children_select on public.children
  for select to authenticated
  using (parent_id = auth.uid() or auth_user_id = auth.uid());
create policy children_insert on public.children
  for insert to authenticated
  with check (parent_id = auth.uid());
create policy children_update on public.children
  for update to authenticated
  using (parent_id = auth.uid())
  with check (parent_id = auth.uid());
-- NO delete policy: deletion is the audited service-path pipeline only
-- (hard-delete across DB/Storage/CDN with a deletion receipt — HARD RULE #6).

-- consent_ledger: parents read & append their own; nothing else, ever.
create policy consent_select on public.consent_ledger
  for select to authenticated using (parent_id = auth.uid());
create policy consent_insert on public.consent_ledger
  for insert to authenticated
  with check (parent_id = auth.uid() and public.is_my_child(child_id));

-- attempts: owner reads; owner (parent or the child itself) appends for that
-- child ONLY; append-only (no update/delete policy + trigger above).
create policy attempts_select on public.attempts
  for select to authenticated using (public.is_my_child(child_id));
create policy attempts_insert on public.attempts
  for insert to authenticated with check (public.is_my_child(child_id));

-- mastery + misconception state: owner READS; clients can NEVER write — the
-- server-side model worker (service role, which bypasses RLS but MUST
-- re-filter by child_id in code) is the only writer.
create policy mastery_select on public.child_skill_mastery
  for select to authenticated using (public.is_my_child(child_id));
create policy misconception_select on public.child_skill_misconception
  for select to authenticated using (public.is_my_child(child_id));

-- ============================================================================
-- GRANTS — nothing to anon (HARD RULE #10: the publishable/anon key that ships
-- inside the public game can NEVER touch child/account data; child-scoped RPCs
-- run only in Edge Functions behind auth).
-- ============================================================================
revoke all on public.skills                    from public, anon;
revoke all on public.children                  from public, anon;
revoke all on public.consent_ledger            from public, anon;
revoke all on public.attempts                  from public, anon;
revoke all on public.child_skill_mastery       from public, anon;
revoke all on public.child_skill_misconception from public, anon;

grant select                 on public.skills                    to authenticated;
grant select, insert, update on public.children                  to authenticated;
grant select, insert         on public.consent_ledger            to authenticated;
grant select, insert         on public.attempts                  to authenticated;
grant select                 on public.child_skill_mastery       to authenticated;
grant select                 on public.child_skill_misconception to authenticated;

-- service_role: full table ACLs (matches Supabase default privileges — BYPASSRLS
-- covers row policies, not table grants). The append-only/immutable triggers
-- above still bind it: even service code cannot rewrite attempts or consent.
grant all on public.skills, public.children, public.consent_ledger, public.attempts,
             public.child_skill_mastery, public.child_skill_misconception to service_role;
