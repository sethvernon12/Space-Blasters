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
  category     text not null check (category in (
                 'addition','subtraction','make-ten','add-to-20','sub-to-20',
                 'missing-number','two-digit-add','two-digit-sub','two-digit-both',
                 'multiplication','two-digit-mult','division','missing-factor')),
                                            -- the game's coarse `skill` tag — the 13
                                            -- allowed values, VERBATIM (contract-locked)
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

-- ============ sessions — one row per play session (attendance/records) ============
-- Many homeschool states require an hours/attendance log; sessions also group
-- attempts. Created/updated ONLY by the record_attempts RPC (definer) or the
-- service path; clients read via can_view_child.
create table public.sessions (
  id                uuid primary key default gen_random_uuid(),
  child_id          uuid not null references public.children(id) on delete cascade,
  client_session_id uuid not null,        -- minted by the game at run start (idempotent upsert key)
  module_id         text not null default 'space-blasters',
  mode              text,                 -- journey|beginner|intermediate|advanced|expert
  started_at        timestamptz not null,
  ended_at          timestamptz check (ended_at is null or ended_at >= started_at),
  attempts_count    int not null default 0 check (attempts_count >= 0),
  correct_count     int not null default 0 check (correct_count >= 0 and correct_count <= attempts_count),
  created_at        timestamptz not null default now(),
  unique (child_id, client_session_id)
);

-- ============ attempts — append-only event log (multi-game module contract) ============
-- EVENT SOURCING: this immutable log is the SOURCE OF TRUTH; child_skill_mastery
-- is a derived, recomputable projection of it (db/scripts/reconcile.mjs proves
-- rebuildability). One row per answered/missed problem. Games NEVER write
-- mastery directly. NO PII: pilot/nickname deliberately absent. We log RICH
-- PRIMITIVES and EVIDENCE — derived labels (slip/guess/misconception) are
-- computed later from evidence, never baked in by the client.
create table public.attempts (
  id                uuid primary key default gen_random_uuid(),
  child_id          uuid not null references public.children(id) on delete cascade,
  session_id        uuid references public.sessions(id),
  skill_id          text not null references public.skills(id),  -- SKILL INTEGRITY: unknown skills rejected
  module_id         text not null default 'space-blasters',
  client_attempt_id uuid not null,        -- IDEMPOTENCY: minted client-side per answer;
                                          -- unique below => insert-or-ignore, replays/
                                          -- offline-resends/multi-device never double-count
  result            text not null check (result in
                      ('correct','incorrect','missed','invalid','misconception','slip','guess')),
                    -- game emits correct / incorrect / missed / invalid ('invalid' =
                    -- discard-quality evidence, e.g. a voice mis-hear — logged but NEVER
                    -- counted toward mastery); 'misconception'/'slip'/'guess' are DERIVED
                    -- labels written by later analysis, never by the client.
  misconception_id  text,                 -- NULL today; Phase 2+ misconception tagging.
  problem_text      text,                 -- evt.text, e.g. '4 − 2' (no PII)
  correct_answer    int,                  -- evt.correctAnswer
  chosen_answer     int,                  -- evt.chosen (NULL when missed)
  response_ms       int check (response_ms is null or response_ms >= 0),
                                          -- ms since THIS problem appeared (game emits from
                                          -- Phase 2 on; NULL for missed problems)
  input_method      text check (input_method is null or input_method in ('voice','typed','tap','click')),
  asr_confidence    numeric check (asr_confidence is null or (asr_confidence >= 0 and asr_confidence <= 1)),
                                          -- speech-recognition confidence, voice answers only
  standard_code     text,                 -- SNAPSHOT of the skill's primary CCSS code at
                                          -- attempt time (resolved server-side), so records
                                          -- stay stable even if the taxonomy is retagged
  run_time_s        numeric,              -- evt.time as emitted today (cumulative run seconds)
  level             int,                  -- evt.level (global curriculum level)
  stage_index       int,                  -- evt.stageIndex (authoritative for skill_id)
  mode              text,                 -- evt.mode (journey|beginner|...|expert)
  model_version     text,
  created_at        timestamptz not null default now(),
  unique (child_id, client_attempt_id)
);
create index attempts_child_skill_idx on public.attempts (child_id, skill_id, created_at desc);
create index attempts_session_idx on public.attempts (session_id);

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
  attempts_count      int not null default 0 check (attempts_count >= 0),
                      -- mastery-counted attempts only ('invalid' rows excluded)
  correct_count       int not null default 0 check (correct_count >= 0 and correct_count <= attempts_count),
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

-- ============ tutor_grants — a parent scopes a tutor to specific children ============
-- Phase-3 roles land later, but the isolation model is locked (and leak-tested)
-- now: a tutor sees ONLY actively-granted children, read-only, revocable.
create table public.tutor_grants (
  id         uuid primary key default gen_random_uuid(),
  tutor_id   uuid not null,               -- auth.users.id of the tutor
  child_id   uuid not null references public.children(id) on delete cascade,
  granted_by uuid not null,               -- the parent's auth.users.id (stored directly so
                                          -- tutor_grants policies never join children —
                                          -- avoids RLS policy recursion)
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tutor_id, child_id)
);

-- ============ rpc_rate_limits — abuse protection state for PIN-keyed RPCs ============
-- A 4-digit PIN is brute-forceable: this table backs per-name call caps and
-- bad-PIN lockout in record_attempts. SERVICE/DEFINER-ONLY (no policies, no
-- client grants — deny-by-default RLS blocks everything).
create table public.rpc_rate_limits (
  key           text primary key,          -- e.g. 'rec:<lowercased player name>'
  window_start  timestamptz not null default now(),
  call_count    int not null default 0 check (call_count >= 0),
  attempt_count int not null default 0 check (attempt_count >= 0),
  bad_pin_count int not null default 0 check (bad_pin_count >= 0),
  locked_until  timestamptz
);

-- ============================================================================
-- ROW LEVEL SECURITY — deny-by-default, keyed to auth.uid() ONLY
-- ============================================================================
alter table public.skills                    enable row level security;
alter table public.children                  enable row level security;
alter table public.consent_ledger            enable row level security;
alter table public.sessions                  enable row level security;
alter table public.attempts                  enable row level security;
alter table public.child_skill_mastery       enable row level security;
alter table public.child_skill_misconception enable row level security;
alter table public.tutor_grants              enable row level security;
alter table public.rpc_rate_limits           enable row level security;

alter table public.skills                    force row level security;
alter table public.children                  force row level security;
alter table public.consent_ledger            force row level security;
alter table public.sessions                  force row level security;
alter table public.attempts                  force row level security;
alter table public.child_skill_mastery       force row level security;
alter table public.child_skill_misconception force row level security;
alter table public.tutor_grants              force row level security;
alter table public.rpc_rate_limits           force row level security;

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

-- Read predicate: owner (parent/child) OR an actively-granted tutor. Used for
-- SELECT policies only — WRITE policies stay is_my_child (tutors are read-only).
-- No recursion: children policies reference tutor_grants directly, and
-- tutor_grants policies reference no other table.
create or replace function public.can_view_child(c uuid) returns boolean
language sql stable security invoker as $$
  select public.is_my_child(c)
      or exists (
        select 1 from public.tutor_grants tg
        where tg.child_id = c and tg.tutor_id = auth.uid() and tg.active
      )
$$;

-- skills: shared read-only reference data for signed-in users; writes are
-- migrations/service only (no client write policy).
create policy skills_read on public.skills
  for select to authenticated using (true);

-- children: a parent sees own children; a child login sees itself. Creation is
-- SERVICE-ONLY (no insert policy/grant): per the VPC spec, a child row is born
-- inside the consent Edge Function AFTER the Stripe transaction verifies — so a
-- client can never create a profile that skips consent. Client updates are
-- limited by COLUMN-LEVEL GRANTS below to nickname/grade_band; the identity &
-- claim columns (parent_id, auth_user_id, legacy_player_id, consent_id) are
-- mutable only via the audited service path (blocks legacy-claim bypass).
-- Unclaimed legacy rows (both ids NULL) match no policy => invisible.
create policy children_select on public.children
  for select to authenticated
  using (parent_id = auth.uid() or auth_user_id = auth.uid()
         or exists (select 1 from public.tutor_grants tg
                     where tg.child_id = children.id     -- MUST be qualified: bare `id`
                       and tg.tutor_id = auth.uid()      -- binds to tutor_grants.id here
                       and tg.active));
create policy children_update on public.children
  for update to authenticated
  using (parent_id = auth.uid())
  with check (parent_id = auth.uid());
-- NO delete policy: deletion is the audited service-path pipeline only
-- (hard-delete across DB/Storage/CDN with a deletion receipt — HARD RULE #6).

-- consent_ledger: parents can READ their own rows. Writes are SERVICE-ONLY
-- (no insert policy/grant): a consent GRANT row is legal evidence and must be
-- written by the Edge Function only after it verifies the Stripe transaction
-- server-side — a client-writable ledger would be forgeable self-attestation.
create policy consent_select on public.consent_ledger
  for select to authenticated using (parent_id = auth.uid());

-- attempts: owner reads; owner (parent or the child itself) appends for that
-- child ONLY, and ONLY while the child has an active consent link (HARD RULE
-- #1: no data collection before VPC; children.consent_id is maintained by the
-- service path and nulled on revocation). Append-only (trigger above).
create policy attempts_select on public.attempts
  for select to authenticated using (public.can_view_child(child_id));
-- NO client insert policy: attempts have exactly ONE write path — the
-- record_attempts RPC below (or the audited service worker) — which enforces
-- the consent gate, idempotency, AND the mastery projection update atomically.
-- A direct client insert would create attempts the projection never saw and
-- break event-log/projection consistency (reconciliation would fail).

-- sessions: owner + granted tutors read; writes are RPC/service-only.
create policy sessions_select on public.sessions
  for select to authenticated using (public.can_view_child(child_id));

-- mastery + misconception state: owner + granted tutors READ; clients can
-- NEVER write — the record_attempts RPC (definer) / service-side model worker
-- (which bypasses RLS but MUST re-filter by child_id in code) are the writers.
create policy mastery_select on public.child_skill_mastery
  for select to authenticated using (public.can_view_child(child_id));
create policy misconception_select on public.child_skill_misconception
  for select to authenticated using (public.can_view_child(child_id));

-- tutor_grants: a tutor sees their own grants; a parent sees/manages grants
-- they issued for their own children. Revocation = active=false (parent).
create policy tutor_grants_select on public.tutor_grants
  for select to authenticated using (tutor_id = auth.uid() or granted_by = auth.uid());
create policy tutor_grants_insert on public.tutor_grants
  for insert to authenticated
  with check (granted_by = auth.uid() and public.is_my_child(child_id));
create policy tutor_grants_update on public.tutor_grants
  for update to authenticated
  using (granted_by = auth.uid()) with check (granted_by = auth.uid());
-- rpc_rate_limits: NO policies at all — deny-by-default locks out every client.

-- ============================================================================
-- GRANTS — nothing to anon (HARD RULE #10: the publishable/anon key that ships
-- inside the public game can NEVER touch child/account data; child-scoped RPCs
-- run only in Edge Functions behind auth).
-- ============================================================================
revoke all on public.skills                    from public, anon;
revoke all on public.children                  from public, anon;
revoke all on public.consent_ledger            from public, anon;
revoke all on public.sessions                  from public, anon;
revoke all on public.attempts                  from public, anon;
revoke all on public.child_skill_mastery       from public, anon;
revoke all on public.child_skill_misconception from public, anon;
revoke all on public.tutor_grants              from public, anon;
revoke all on public.rpc_rate_limits           from public, anon, authenticated;

grant select on public.skills to authenticated;
-- children: clients may update ONLY the cosmetic columns (column-level grant);
-- identity/claim columns and row creation are service-path only.
grant select on public.children to authenticated;
grant update (nickname, grade_band, updated_at) on public.children to authenticated;
grant select on public.consent_ledger to authenticated;   -- read-only: writes are service-only
grant select on public.sessions to authenticated;         -- writes: RPC/service only
grant select on public.attempts to authenticated;          -- writes: record_attempts RPC only
grant select on public.child_skill_mastery       to authenticated;
grant select on public.child_skill_misconception to authenticated;
grant select, insert on public.tutor_grants to authenticated;
-- updates limited to revocation fields: nobody (not even the granting parent)
-- can client-side re-scope an existing grant to a different child/tutor
grant update (active, revoked_at) on public.tutor_grants to authenticated;

-- service_role: full table ACLs (matches Supabase default privileges — BYPASSRLS
-- covers row policies, not table grants). The append-only/immutable triggers
-- above still bind it: even service code cannot rewrite attempts or consent.
grant all on public.skills, public.children, public.consent_ledger, public.sessions,
             public.attempts, public.child_skill_mastery, public.child_skill_misconception,
             public.tutor_grants, public.rpc_rate_limits to service_role;

-- ============================================================================
-- record_attempts — THE atomic write path for game answers (Phase 2).
-- ============================================================================
-- Mirrors the existing submit_score pattern (owner-approved interim keying,
-- 2026-07-03): SECURITY DEFINER, callable with the publishable key, but it
-- authenticates name+PIN against players.pin_hash INSIDE the function,
-- resolves child_id SERVER-SIDE (players.id -> children.legacy_player_id) and
-- NEVER accepts a child id from the client. Write-only: returns counts only.
--
-- Guarantees, in order of the function body:
--   * RATE LIMITING: per-name call/attempt caps per minute; >=5 bad PINs in
--     15 min locks the name for 15 min (single generic 'rate_limited'/
--     'denied' errors — no oracle for which part failed).
--   * CONSENT GATE: the resolved child must carry an active consent link
--     (children.consent_id) — no consent, no data (HARD RULE #1).
--   * IDEMPOTENCY: insert-or-ignore on (child_id, client_attempt_id); mastery
--     is updated ONLY for rows actually inserted, so retries/offline replays/
--     multi-device flushes can never double-count.
--   * ATOMICITY: session upsert + attempt inserts + mastery upserts commit or
--     roll back as one transaction (a plpgsql function body).
--   * SKILL INTEGRITY: skill resolved server-side from stage_index against
--     skills.position; the client's coarse tag must agree (category or
--     alt_categories) or the element is rejected. standard_code snapshots the
--     skill's primary CCSS code at write time.
--   * MODEL MIRROR: the mastery math below implements contracts/mastery.mjs
--     ('mastery-v1') exactly; db/scripts/reconcile.mjs replays the log through
--     the JS function and diffs — divergence fails CI.
--
-- PIN scheme CONFIRMED against the live production functions (owner, 2026-07-03):
-- bcrypt via pgcrypto — verify with pin_hash = crypt(p_pin, pin_hash), exactly
-- like signup_or_login/submit_score. pgcrypto's crypt/gen_salt live in the
-- `extensions` schema on Supabase, hence the search_path below (pg_temp pinned
-- last as hardening). Name resolution is case-insensitive + trimmed and the
-- PIN must match ^[0-9]{4}$ — matching signup_or_login exactly, so a valid
-- child is never rejected on a name-case/whitespace mismatch.
-- ============================================================================
create or replace function public.verify_pin(p_pin text, p_hash text)
returns boolean language sql immutable
set search_path = public, extensions, pg_temp   -- pgcrypto lives in `extensions` on Supabase
as $$ select p_hash is not null and crypt(p_pin, p_hash) = p_hash $$;

create or replace function public.record_attempts(p_name text, p_pin text, p_batch jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp   -- match the prod RPCs (pgcrypto in `extensions`)
as $$
declare
  v_key         text := 'rec:' || lower(trim(coalesce(p_name,'')));
  v_now         timestamptz := now();
  v_rl          public.rpc_rate_limits%rowtype;
  v_player      public.players%rowtype;
  v_child       public.children%rowtype;
  v_session_id  uuid;
  v_el          jsonb;
  v_skill       public.skills%rowtype;
  v_result      text;
  v_attempt_id  uuid;
  v_inserted_id uuid;
  v_n_batch     int;
  v_inserted    int := 0;
  v_duplicates  int := 0;
  v_rejected    int := 0;
  v_counted     boolean;
  v_correct     boolean;
  v_m           public.child_skill_mastery%rowtype;
  v_w           numeric;
  v_gap_days    numeric;
begin
  -- ---- shape checks (cheap, before any lookup) ----
  -- PIN format ^[0-9]{4}$ required, matching signup_or_login exactly; a
  -- malformed PIN is a client bug (bad_request), not a brute-force strike.
  if p_name is null or p_pin is null or p_batch is null
     or p_pin !~ '^[0-9]{4}$'
     or jsonb_typeof(p_batch->'attempts') <> 'array' then
    return json_build_object('ok', false, 'error', 'bad_request');
  end if;
  v_n_batch := jsonb_array_length(p_batch->'attempts');
  if v_n_batch > 200 then
    return json_build_object('ok', false, 'error', 'batch_too_large');
  end if;

  -- ---- rate limiting (locked row per name; serializes concurrent calls) ----
  insert into public.rpc_rate_limits as rl (key) values (v_key)
    on conflict (key) do update set key = rl.key   -- no-op; just get the lock target
    returning * into v_rl;
  select * into v_rl from public.rpc_rate_limits where key = v_key for update;
  if v_rl.locked_until is not null and v_rl.locked_until > v_now then
    return json_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if v_now - v_rl.window_start > interval '1 minute' then
    update public.rpc_rate_limits
       set window_start = v_now, call_count = 0, attempt_count = 0
     where key = v_key;
    v_rl.call_count := 0; v_rl.attempt_count := 0;
  end if;
  if v_rl.call_count >= 6 or v_rl.attempt_count + v_n_batch > 300 then
    return json_build_object('ok', false, 'error', 'rate_limited');
  end if;
  update public.rpc_rate_limits
     set call_count = call_count + 1, attempt_count = attempt_count + v_n_batch
   where key = v_key;

  -- ---- authenticate: name + PIN verified server-side (mirror submit_score) ----
  select * into v_player from public.players where lower(name) = lower(trim(p_name));
  if v_player.id is null or not public.verify_pin(p_pin, v_player.pin_hash) then
    update public.rpc_rate_limits
       set bad_pin_count = bad_pin_count + 1,
           locked_until = case when bad_pin_count + 1 >= 5
                               then v_now + interval '15 minutes' end
     where key = v_key;
    return json_build_object('ok', false, 'error', 'denied');   -- no user/PIN oracle
  end if;
  -- a good PIN clears the bad-PIN strike counter
  update public.rpc_rate_limits set bad_pin_count = 0 where key = v_key;

  -- ---- resolve the child SERVER-SIDE; enforce the consent gate ----
  select * into v_child from public.children where legacy_player_id = v_player.id;
  if v_child.id is null then
    return json_build_object('ok', false, 'error', 'no_profile');
  end if;
  if v_child.consent_id is null then
    return json_build_object('ok', false, 'error', 'no_consent');  -- HARD RULE #1
  end if;

  -- ---- session upsert (attendance/records); malformed session data => bad_request ----
  begin
    insert into public.sessions as s (child_id, client_session_id, module_id, mode, started_at, ended_at)
    values (
      v_child.id,
      (p_batch->>'client_session_id')::uuid,
      coalesce(p_batch->>'module_id', 'space-blasters'),
      p_batch->>'mode',
      coalesce((p_batch->>'started_at')::timestamptz, v_now),
      (p_batch->>'ended_at')::timestamptz
    )
    on conflict (child_id, client_session_id) do update
      set ended_at = coalesce(excluded.ended_at, s.ended_at),
          mode     = coalesce(s.mode, excluded.mode)
    returning id into v_session_id;
  exception when others then
    return json_build_object('ok', false, 'error', 'bad_request');
  end;

  -- ---- per-element: validate, insert-or-ignore, update mastery for NEW rows only ----
  for v_el in select * from jsonb_array_elements(p_batch->'attempts') loop
    v_result := v_el->>'result';
    v_attempt_id := null;
    begin
      v_attempt_id := (v_el->>'client_attempt_id')::uuid;
    exception when others then null;
    end;
    -- SKILL INTEGRITY: resolve by stage position; the coarse tag must agree
    begin
      select * into v_skill from public.skills sk
       where sk.position = (v_el->>'stage_index')::int;
    exception when others then
      v_skill.id := null;
    end;
    if v_attempt_id is null or v_skill.id is null
       or v_result not in ('correct','incorrect','missed','invalid')
       or not (v_el->>'skill' = v_skill.category or (v_el->>'skill') = any(v_skill.alt_categories)) then
      v_rejected := v_rejected + 1;
      continue;
    end if;

    -- a malformed element (bad casts, CHECK violations) rejects THAT element
    -- only — never the whole batch (nested block = per-element subtransaction)
    begin
      insert into public.attempts
        (child_id, session_id, skill_id, module_id, client_attempt_id, result,
         problem_text, correct_answer, chosen_answer, response_ms, input_method,
         asr_confidence, standard_code, run_time_s, level, stage_index, mode, model_version)
      values (
        v_child.id, v_session_id, v_skill.id,
        coalesce(p_batch->>'module_id', 'space-blasters'),
        v_attempt_id, v_result,
        left(v_el->>'problem_text', 64),
        (v_el->>'correct_answer')::int,
        (v_el->>'chosen_answer')::int,
        (v_el->>'response_ms')::int,
        v_el->>'input_method',
        (v_el->>'asr_confidence')::numeric,
        v_skill.ccss_codes[1],                       -- standard_code snapshot
        (v_el->>'run_time_s')::numeric,
        (v_el->>'level')::int,
        (v_el->>'stage_index')::int,
        p_batch->>'mode',
        'mastery-v1'
      )
      on conflict (child_id, client_attempt_id) do nothing
      returning id into v_inserted_id;
    exception when others then
      v_rejected := v_rejected + 1;
      continue;
    end;

    if v_inserted_id is null then
      v_duplicates := v_duplicates + 1;            -- replay — mastery untouched
      continue;
    end if;
    v_inserted := v_inserted + 1;

    -- ---- mastery update (mirror of contracts/mastery.mjs, 'mastery-v1') ----
    v_counted := v_result <> 'invalid';            -- invalid = logged, never counted
    if v_counted then
      v_correct := v_result = 'correct';
      select * into v_m from public.child_skill_mastery
       where child_id = v_child.id and skill_id = v_skill.id for update;
      if v_m.child_id is null then
        insert into public.child_skill_mastery
          (child_id, skill_id, alpha, beta, attempts_count, correct_count,
           last_seen_at, last_correct_at, model_version)
        values (v_child.id, v_skill.id,
                1 + case when v_correct then 1 else 0 end,
                1 + case when v_correct then 0 else 1 end,
                1, case when v_correct then 1 else 0 end,
                v_now, case when v_correct then v_now end, 'mastery-v1');
      else
        v_gap_days := greatest(0, extract(epoch from (v_now - v_m.last_seen_at)) / 86400.0);
        v_w := power(0.5, v_gap_days / v_m.decay_halflife_days);
        update public.child_skill_mastery set
          alpha = (1 + (v_m.alpha - 1) * v_w) + case when v_correct then 1 else 0 end,
          beta  = (1 + (v_m.beta  - 1) * v_w) + case when v_correct then 0 else 1 end,
          attempts_count = v_m.attempts_count + 1,
          correct_count  = v_m.correct_count + case when v_correct then 1 else 0 end,
          last_seen_at   = v_now,
          last_correct_at = case when v_correct then v_now else v_m.last_correct_at end,
          updated_at = v_now
        where child_id = v_child.id and skill_id = v_skill.id;
      end if;
      update public.sessions
         set attempts_count = attempts_count + 1,
             correct_count  = correct_count + case when v_correct then 1 else 0 end
       where id = v_session_id;
    end if;
  end loop;

  -- WRITE-ONLY: counts only; never child data.
  return json_build_object('ok', true,
    'inserted', v_inserted, 'duplicates', v_duplicates, 'rejected', v_rejected);
end $$;

-- callable with the publishable key — authenticates name+PIN INSIDE (owner-
-- approved interim pattern, mirroring submit_score); write-only, counts-only.
revoke all on function public.record_attempts(text, text, jsonb) from public;
grant execute on function public.record_attempts(text, text, jsonb) to anon, authenticated, service_role;
revoke all on function public.verify_pin(text, text) from public, anon, authenticated;
