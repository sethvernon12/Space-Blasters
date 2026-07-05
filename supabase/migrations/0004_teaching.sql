-- ============================================================================
-- 0004_teaching.sql — Milestone 3: tutor teaching write-power + extensibility
-- seams. LOCAL ONLY, additive. MUST be security-reviewed (review + reviewer
-- sub-agent, like 0001) BEFORE any DEV/prod apply — it adds a write gate, a
-- SECURITY DEFINER trigger, and an RLS-guarded artifact table.
--
-- Builds:
--   A. can_write_child(c): the teaching-WRITE grant gate, distinct from the
--      read-only can_view_child. Owner (is_my_child) OR an active grant with
--      can_write. attempts/mastery/consent/identity stay is_my_child/service-only.
--   B. tutor_grants: generic role label + optional domain + can_write capability
--      (a future coach/specialist/observer is DATA, not code).
--   C. skills.subject: math becomes one subject on the skills/attempts/mastery
--      spine (attempts/mastery derive subject via skill_id — no denorm).
--   D. teaching_artifacts: ONE table separated by KIND; author is a column
--      (author_role/author_id). Immutable/append-only; override or revoke = a
--      SUPERSEDING row (supersedes_id), never an in-place edit. A tutor's grade
--      lives here and NEVER rewrites attempts.result/mastery — the deterministic
--      solver stays canonical.
--   E. assignments insert/update move to the write gate (view-only grants can't assign).
--   F. Each tutor grant logs an explicit parental-disclosure consent event.
--
-- LEFT AS ROOM (columns present, NOT enforced/built): visibility scope,
-- storage_ref media backend, payload/metadata, polymorphic target, ai/system
-- authorship, grant domain scoping.
-- ============================================================================

-- ---- B. generic grants + write capability (roles/domains are DATA) ----
alter table public.tutor_grants
  add column if not exists role      text not null default 'tutor',   -- no CHECK: future roles are data
  add column if not exists domain    text,                            -- optional subject scope, e.g. 'math'
  add column if not exists can_write boolean not null default true;   -- view-only grants set false

-- ---- A. can_write_child — the teaching-WRITE gate (distinct from can_view_child) ----
create or replace function public.can_write_child(c uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select public.is_my_child(c)
      or exists (
        select 1 from public.tutor_grants tg
        where tg.child_id = c and tg.tutor_id = auth.uid()
          and tg.active and tg.can_write
      )
$$;

-- ---- C. subject dimension (math is one subject on the spine) ----
alter table public.skills
  add column if not exists subject text not null default 'math';      -- no CHECK: subjects are data

-- ---- F. widen consent_ledger CHECKs so a tutor grant is a logged disclosure ----
alter table public.consent_ledger
  drop constraint if exists consent_ledger_action_check,
  add  constraint consent_ledger_action_check check (action in ('grant','revoke','disclosure'));
alter table public.consent_ledger
  drop constraint if exists consent_ledger_method_check,
  add  constraint consent_ledger_method_check
       check (method in ('stripe_card_transaction','legacy_claim','other_vpc','parent_authorization'));

-- ---- D. teaching_artifacts — one table, separated by KIND; author is a column ----
create table public.teaching_artifacts (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children(id) on delete cascade,
  kind          text not null check (kind in ('grade','annotation','feedback','reteach','material')),
  author_role   text not null check (author_role in ('parent','tutor','child','ai','system')),
  author_id     uuid,                                    -- auth.users.id; null for ai/system
  subject       text not null default 'math',
  payload       jsonb not null default '{}'::jsonb,      -- structured per-kind content (no PII)
  target_kind   text,                                    -- polymorphic: 'attempt'|'assignment'|'submission'
  target_id     uuid,                                    -- no FK (spans floors)
  supersedes_id uuid references public.teaching_artifacts(id),  -- override/revoke chain (immutable, auditable)
  storage_ref   text,                                    -- ROOM: media backend ref (unused)
  visibility    text not null default 'family'
                check (visibility in ('private','family','followers','internal-staff','sent-to-child')),
                                                          -- ROOM: present, NOT enforced yet
  created_at    timestamptz not null default now()
);
create index teaching_artifacts_child_idx on public.teaching_artifacts (child_id, kind);

-- immutable / append-only — override & revoke are SUPERSEDING rows, never edits
create trigger teaching_artifacts_immutable
  before update or delete on public.teaching_artifacts
  for each row execute function public.forbid_mutation();

alter table public.teaching_artifacts enable row level security;

-- READ: owner + granted tutor. (visibility scoping is LEFT AS ROOM — not enforced here.)
create policy teaching_artifacts_select on public.teaching_artifacts
  for select to authenticated using (public.can_view_child(child_id));

-- INSERT: truthful provenance — the author_role must match how the caller is
-- actually related to the child (a tutor can't masquerade as the parent), and
-- author_id must be the caller. Tutors need an ACTIVE can_write grant.
create policy teaching_artifacts_insert on public.teaching_artifacts
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and (
      (author_role = 'parent' and public.is_my_child(child_id))
      or (author_role = 'tutor' and exists (
            select 1 from public.tutor_grants tg
            where tg.child_id = teaching_artifacts.child_id
              and tg.tutor_id = auth.uid() and tg.active and tg.can_write))
    )
  );
-- NO update/delete policy: immutable. ai/system-authored rows arrive via the
-- audited service path (later floors), never a client.

revoke all on public.teaching_artifacts from public, anon;
grant select, insert on public.teaching_artifacts to authenticated;

-- ---- E. assignments: assigning is a teaching WRITE -> move to can_write_child ----
drop policy if exists assignments_insert on public.assignments;
create policy assignments_insert on public.assignments
  for insert to authenticated
  with check (public.can_write_child(child_id) and assigned_by = auth.uid());
drop policy if exists assignments_update on public.assignments;
create policy assignments_update on public.assignments
  for update to authenticated
  using (public.can_write_child(child_id))
  with check (public.can_write_child(child_id));

-- ---- F. disclosure trigger: every tutor grant is a logged parental disclosure ----
create or replace function public.log_tutor_disclosure() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  -- the parent (granted_by) disclosed this child's data to the grantee (tutor).
  -- consent_ledger is service-only + append-only; this definer trigger is the
  -- writer. No PII in detail — ids and grant metadata only.
  insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
  values (new.granted_by, new.child_id, 'disclosure', 'parent_authorization', 'disclosure-v1',
          jsonb_build_object('grantee_id', new.tutor_id, 'grant_id', new.id,
                             'role', new.role, 'domain', new.domain, 'can_write', new.can_write));
  return new;
end $$;

create trigger tutor_grant_disclosure
  after insert on public.tutor_grants
  for each row execute function public.log_tutor_disclosure();
