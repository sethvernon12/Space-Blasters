-- ============================================================================
-- 0022_homeschool_arena.sql — Slice AR-3: homeschool self-serve onboarding.
-- LOCAL ONLY, additive. MUST pass SEC-03 + the cross-family isolation e2e before
-- any DEV/prod apply.
--
-- Founder decision of record (2026-07-10): ARENA lives on the family GROUP, never
-- on the identity — one Google identity may hold both an Academy role AND a
-- homeschool family, and no view ever mixes arenas. So a homeschool family is a
-- `groups` row (purpose='family') tagged arena='homeschool', created by the parent
-- self-serve. (Academy families, arena='academy', are AR-4 — Academy-controlled.)
--
-- Onboarding: a lobby adult picks "Set up my homeschool" -> create_homeschool_family
-- makes the standalone family group (no Academy link) + a guardian membership, so
-- the first-run router now sees them as a parent (empty roster) and they add their
-- first learner through the EXISTING consent kernel (unchanged). A grade-level
-- STARTER TEMPLATE seeds a few real to-dos (assignments) so the child's hub is
-- populated on day one — NEVER fabricated mastery (the honest-record rule: mastery
-- is only ever derived from real attempts, never hand-written).
--
-- DEFINER HYGIENE: every function SECURITY DEFINER, set search_path='', schema-
-- qualified, EXECUTE service/authenticated only (never public/anon).
-- ============================================================================

-- ---- arena tag on the family group (nullable; only family groups set it) --------
alter table public.groups add column if not exists arena text
  check (arena is null or arena in ('homeschool', 'academy'));

-- At most ONE family per creator per arena — makes create_homeschool_family
-- exactly-once under concurrency (its idempotency select is otherwise TOCTOU).
create unique index if not exists groups_family_arena_uniq
  on public.groups (created_by, arena) where purpose = 'family' and arena is not null;

-- ---- create_homeschool_family: self-serve standalone family (idempotent) --------
create or replace function public.create_homeschool_family()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_gid uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  -- a child actor can never create a family/arena (Academy-controlled trust never
  -- comes from a child login, and self-serve is an ADULT choice)
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- idempotent: return the caller's existing homeschool family if one exists
  select id into v_gid from public.groups
   where created_by = v_uid and purpose = 'family' and arena = 'homeschool'
   order by created_at limit 1;
  if v_gid is not null then return jsonb_build_object('ok', true, 'group_id', v_gid, 'existing', true); end if;
  begin
    insert into public.groups (purpose, name, arena, created_by)
      values ('family', 'My homeschool', 'homeschool', v_uid)
      returning id into v_gid;
  exception when unique_violation then
    -- lost a concurrent race for the SAME parent — return the winner's family
    select id into v_gid from public.groups
     where created_by = v_uid and purpose = 'family' and arena = 'homeschool'
     order by created_at limit 1;
    return jsonb_build_object('ok', true, 'group_id', v_gid, 'existing', true);
  end;
  insert into public.memberships (group_id, member_actor_id, role, active)
    values (v_gid, v_uid, 'guardian', true);
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'family.create', null, 'allow', jsonb_build_object('group_id', v_gid, 'arena', 'homeschool'));
  return jsonb_build_object('ok', true, 'group_id', v_gid, 'existing', false);
end $$;
revoke all on function public.create_homeschool_family() from public, anon;
grant execute on function public.create_homeschool_family() to authenticated;

-- ---- my_family: the caller's family group (id + arena) for the first-run router
-- Resolves via created_by OR an active guardian/parent membership (forward-safe for
-- the AR-4 Academy path where the Academy — not the parent — creates the group).
create or replace function public.my_family()
returns table (group_id uuid, arena text)
language sql stable security definer set search_path = ''
as $$
  select g.id, g.arena
    from public.groups g
   where g.purpose = 'family'
     and (g.created_by = auth.uid()
          or exists (select 1 from public.memberships m
                     where m.group_id = g.id and m.member_actor_id = auth.uid()
                       and m.active and m.role in ('guardian', 'parent')))
   order by g.created_at
   limit 1
$$;
revoke all on function public.my_family() from public, anon;
grant execute on function public.my_family() to authenticated;

-- ---- apply_starter_template: grade-level starter to-dos for an owned child ------
-- Honest "populated hub in <5 min": creates a few grade-appropriate ASSIGNMENTS
-- (real to-dos the parent authors), NEVER child_skill_mastery (mastery is derived
-- from real attempts only). Owner-only, consent-gated, idempotent.
create or replace function public.apply_starter_template(p_child_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_child public.children%rowtype; v_grade text; v_n int := 0; v_sk record;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_child from public.children where id = p_child_id;
  -- owner-only: uniform not_found for not-mine / not-there (no cross-family probe)
  if v_child.id is null or v_child.parent_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  -- HARD RULE #1: no learning artifacts before Verifiable Parental Consent
  if v_child.consent_id is null then return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  -- idempotent: never duplicate a starter plan / clobber existing work
  if exists (select 1 from public.assignments where child_id = p_child_id) then
    return jsonb_build_object('ok', true, 'created', 0, 'existing', true);
  end if;
  v_grade := nullif(v_child.grade_band, '');
  -- grade-appropriate: the first few skills tagged for this grade, by ladder position
  for v_sk in
    select id, display_name from public.skills where grade_band = v_grade order by position limit 3
  loop
    insert into public.assignments (child_id, assigned_by, skill_id, title, status)
      values (p_child_id, v_uid, v_sk.id, left('Starter: ' || v_sk.display_name, 120), 'assigned');
    v_n := v_n + 1;
  end loop;
  -- fallback: no skills tagged for that grade (or grade unset) -> foundational three
  if v_n = 0 then
    for v_sk in select id, display_name from public.skills order by position limit 3
    loop
      insert into public.assignments (child_id, assigned_by, skill_id, title, status)
        values (p_child_id, v_uid, v_sk.id, left('Starter: ' || v_sk.display_name, 120), 'assigned');
      v_n := v_n + 1;
    end loop;
  end if;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'starter_template.apply', p_child_id, 'allow', jsonb_build_object('created', v_n, 'grade', v_grade));
  return jsonb_build_object('ok', true, 'created', v_n, 'existing', false);
end $$;
revoke all on function public.apply_starter_template(uuid) from public, anon;
grant execute on function public.apply_starter_template(uuid) to authenticated;
