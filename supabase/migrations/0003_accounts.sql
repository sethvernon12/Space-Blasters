-- ============================================================================
-- 0003_accounts.sql — Milestone 3: the accounts-era write path + assignments.
-- ============================================================================
-- STATUS: NOT APPLIED to DEV or PROD. Additive, LOCAL-verified only. This
-- migration MUST be re-reviewed (security review + reviewer sub-agent, as 0001
-- was) BEFORE it ever reaches a hosted database — it adds a SECURITY DEFINER
-- write path and new RLS-guarded tables.
--
--   1. record_attempts_authed(child_id, batch): the write path for a SIGNED-IN
--      caller (parent or the child herself). Authorizes via is_my_child on
--      auth.uid() (tutors are READ-ONLY -> excluded), enforces the consent gate,
--      then reuses record_attempts' EXACT insert/idempotency/context/mastery
--      logic. No name/PIN. SECURITY DEFINER, so the in-code child_id re-filter
--      is mandatory (HARD RULE #2).
--   2. assignments: real-but-minimal. A parent OR a granted tutor may assign for
--      a child they can view; owner + granted tutor read/update. This makes
--      "a tutor can assign for GRANTED children only" a real isolation test.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. record_attempts_authed — auth.uid()-scoped write path
-- ---------------------------------------------------------------------------
create or replace function public.record_attempts_authed(p_child_id uuid, p_batch jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_now         timestamptz := now();
  v_uid         uuid := auth.uid();
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
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'unauthenticated');
  end if;
  if p_child_id is null or p_batch is null
     or jsonb_typeof(p_batch->'attempts') <> 'array' then
    return json_build_object('ok', false, 'error', 'bad_request');
  end if;
  v_n_batch := jsonb_array_length(p_batch->'attempts');
  if v_n_batch > 200 then
    return json_build_object('ok', false, 'error', 'batch_too_large');
  end if;

  -- AUTHORIZE: caller must OWN this child (parent or the child herself). Tutors
  -- are read-only, so is_my_child (NOT can_view_child). Definer bypasses RLS =>
  -- this in-code re-filter by child_id is MANDATORY (HARD RULE #2).
  if not public.is_my_child(p_child_id) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    return json_build_object('ok', false, 'error', 'no_profile');
  end if;
  if v_child.consent_id is null then
    return json_build_object('ok', false, 'error', 'no_consent');   -- HARD RULE #1
  end if;

  -- ---- session upsert (identical to record_attempts) ----
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

  -- ---- per-element loop (IDENTICAL to record_attempts, incl. context + mastery) ----
  for v_el in select * from jsonb_array_elements(p_batch->'attempts') loop
    v_result := v_el->>'result';
    v_attempt_id := null;
    begin
      v_attempt_id := (v_el->>'client_attempt_id')::uuid;
    exception when others then null;
    end;
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

    begin
      insert into public.attempts
        (child_id, session_id, skill_id, module_id, client_attempt_id, result,
         problem_text, correct_answer, chosen_answer, response_ms, input_method,
         asr_confidence, standard_code, run_time_s, level, stage_index, mode, model_version,
         context)
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
        v_skill.ccss_codes[1],
        (v_el->>'run_time_s')::numeric,
        (v_el->>'level')::int,
        (v_el->>'stage_index')::int,
        p_batch->>'mode',
        'mastery-v1',
        coalesce(v_el->'context', '{}'::jsonb)
      )
      on conflict (child_id, client_attempt_id) do nothing
      returning id into v_inserted_id;
    exception when others then
      v_rejected := v_rejected + 1;
      continue;
    end;

    if v_inserted_id is null then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;
    v_inserted := v_inserted + 1;

    v_counted := v_result <> 'invalid';
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

  return json_build_object('ok', true,
    'inserted', v_inserted, 'duplicates', v_duplicates, 'rejected', v_rejected);
end $$;

-- signed-in only; never anon (no name/PIN path here)
revoke all on function public.record_attempts_authed(uuid, jsonb) from public, anon;
grant execute on function public.record_attempts_authed(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. assignments — real-but-minimal, RLS-scoped
-- ---------------------------------------------------------------------------
create table public.assignments (
  id          uuid primary key default gen_random_uuid(),
  child_id    uuid not null references public.children(id) on delete cascade,
  assigned_by uuid not null,                 -- auth.users.id of the parent OR tutor
  skill_id    text not null references public.skills(id),
  title       text not null check (char_length(title) between 1 and 120),
  status      text not null default 'assigned' check (status in ('assigned','in_progress','done')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index assignments_child_idx on public.assignments (child_id);

alter table public.assignments enable row level security;

-- READ: owner (parent/child) + granted tutor.
create policy assignments_select on public.assignments
  for select to authenticated using (public.can_view_child(child_id));

-- INSERT: a parent OR a granted tutor may assign for a child they can VIEW; the
-- assigned_by must be the caller (no spoofing). A tutor with no active grant for
-- the child fails can_view_child -> cannot assign. This is the isolation test.
create policy assignments_insert on public.assignments
  for insert to authenticated
  with check (public.can_view_child(child_id) and assigned_by = auth.uid());

-- UPDATE (status/progress): owner + granted tutor.
create policy assignments_update on public.assignments
  for update to authenticated
  using (public.can_view_child(child_id))
  with check (public.can_view_child(child_id));
-- NO delete policy: managed via the audited service path only.

grant select, insert, update on public.assignments to authenticated;
