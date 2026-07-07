-- ============================================================================
-- 0011_review_hardening.sql — fixes from the 0007–0010 red-team review.
-- LOCAL ONLY, additive. MUST be security-reviewed before any DEV/prod (SEC-03).
--
--   C1  join_group requires GROUP OWNERSHIP (+ can_write_child for a child
--       member) — no bare group-id self-join (invites = future RM-13).
--   C2  child-subject events are visible only to that child's guardians/viewers,
--       never to group co-members via the group branch.
--   H3  grading recomputes correctness from operator/operands server-side and
--       ignores any client-supplied correct_answer (approve_grade + solver.ts).
--   M4  drain_derivations() is worker/service-only (revoked from authenticated).
--   M5  approve_grade is idempotent per submission (no double-count).
--   M6  rebuild_assessment requires can_write_child + active consent.
--   M7  every delivered assignment prompt passes moderate_text (KER-5).
--   L10 moderate_text pins search_path=''.
-- ============================================================================

-- ---- L10: pin moderate_text ----
create or replace function public.moderate_text(t text) returns text
language sql immutable
set search_path = ''
as $$
  select case when t ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|[0-9]{3}[-.[:space:]][0-9]{3}[-.[:space:]][0-9]{4})'
              then 'Nice effort — see your teacher''s notes.' else coalesce(t, '') end
$$;

-- ---- C2: events_select — child-subject rows only to the child's guardians ----
drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated
  using (
    (subject_child_id is not null and public.can_view_child(subject_child_id) and public.has_active_consent(subject_child_id))
    or (subject_child_id is null and group_id is not null and public.is_group_member(group_id))
  );

-- ---- C1: join_group requires ownership (+ write authority over a child) ----
create or replace function public.join_group(p_group_id uuid, p_member_child_id uuid, p_member_actor_id uuid, p_role text default 'member')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if (p_member_child_id is null) = (p_member_actor_id is null) then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  -- AUTHORIZE: only the group OWNER manages its roster. Bare group-id self-join
  -- is forbidden (invite-based enrollment is the future RM-13 path).
  if v_group.created_by <> v_uid then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- adding a CHILD discloses them to the group: require write authority over the child
  if p_member_child_id is not null and not public.can_write_child(p_member_child_id) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select id into v_membership_id from public.memberships
   where group_id = p_group_id
     and member_child_id is not distinct from p_member_child_id
     and member_actor_id is not distinct from p_member_actor_id;
  if v_membership_id is null then
    insert into public.memberships (group_id, member_child_id, member_actor_id, role, active)
    values (p_group_id, p_member_child_id, p_member_actor_id, p_role, true) returning id into v_membership_id;
  else
    update public.memberships set active = true, left_at = null, role = p_role where id = v_membership_id;
  end if;

  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('membership', v_uid, p_member_child_id, p_group_id,
          jsonb_build_object('action', 'join', 'role', p_role, 'membership_id', v_membership_id))
  returning id into v_event_id;
  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
  values (v_event_id, 'join', p_group_id, p_member_child_id, p_member_actor_id, p_role,
          'join:' || v_membership_id::text || ':' || v_event_id::text, 'pending');
  return jsonb_build_object('ok', true, 'membership_id', v_membership_id, 'event_id', v_event_id);
end $$;

-- ---- M4: drain is worker/service-only ----
revoke execute on function public.drain_derivations() from authenticated;

-- ---- H3 + M5: approve_grade recomputes correctness from operands; idempotent --
create or replace function public.approve_grade(p_proposal_id uuid, p_override_feedback text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_art public.teaching_artifacts%rowtype;
  v_sub public.submissions%rowtype;
  v_expected int; v_correct boolean; v_verdict text; v_feedback text; v_event_id uuid; v_overridden boolean;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_art from public.teaching_artifacts where id = p_proposal_id and kind = 'grade' and author_role = 'ai';
  if v_art.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_art.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_art.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  select * into v_sub from public.submissions where id = v_art.target_id;
  if v_sub.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_submission'); end if;
  -- M5: idempotent — one authoritative grade per submission
  if exists (select 1 from public.events where kind = 'grade' and (payload->>'submission_id')::uuid = v_sub.id) then
    return jsonb_build_object('ok', false, 'error', 'already_recorded');
  end if;

  -- H3: the SOLVER recomputes from operator/operands; a client-supplied
  -- correct_answer is IGNORED. Missing/invalid DNA fails closed to incorrect.
  v_expected := case v_sub.problem_dna->>'operator'
    when '+' then (v_sub.problem_dna->'operands'->>0)::int + (v_sub.problem_dna->'operands'->>1)::int
    when '-' then (v_sub.problem_dna->'operands'->>0)::int - (v_sub.problem_dna->'operands'->>1)::int
    when '*' then (v_sub.problem_dna->'operands'->>0)::int * (v_sub.problem_dna->'operands'->>1)::int
    else null end;
  v_correct := (v_expected is not null and v_sub.submitted_answer is not distinct from v_expected);
  v_verdict := case when v_correct then 'correct' else 'incorrect' end;
  v_overridden := p_override_feedback is not null;
  v_feedback := public.moderate_text(coalesce(p_override_feedback, v_art.payload->>'feedback', ''));

  insert into public.events (kind, author_actor_id, subject_child_id, context_ref_kind, context_ref_id, payload)
  values ('grade', auth.uid(), v_art.child_id, 'submission', v_sub.id,
          jsonb_build_object('verdict', v_verdict, 'score', case when v_correct then 100 else 0 end,
                             'submission_id', v_sub.id, 'skill_id', v_sub.skill_id, 'ai_proposal_id', p_proposal_id,
                             'overridden', v_overridden, 'model', v_art.payload->>'model', 'prompt_version', v_art.payload->>'prompt_version'))
  returning id into v_event_id;

  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, target_kind, target_id, supersedes_id, visibility_scope)
  values (v_art.child_id, auth.uid(), case when public.is_my_child(v_art.child_id) then 'parent' else 'tutor' end,
          'feedback', 'math', jsonb_build_object('feedback', v_feedback, 'grade_event_id', v_event_id),
          'submission', v_sub.id, p_proposal_id, 'sent-to-child');

  insert into public.child_skill_assessment (child_id, skill_id, graded_count, correct_count, transfer_success_count, last_graded_at)
  values (v_sub.child_id, v_sub.skill_id, 1, case when v_correct then 1 else 0 end, case when v_correct then 1 else 0 end, now())
  on conflict (child_id, skill_id) do update set
    graded_count = public.child_skill_assessment.graded_count + 1,
    correct_count = public.child_skill_assessment.correct_count + case when v_correct then 1 else 0 end,
    transfer_success_count = public.child_skill_assessment.transfer_success_count + case when v_correct then 1 else 0 end,
    last_graded_at = now(), updated_at = now();

  perform public.write_audit('ai.grade.approve', v_art.child_id, 'allow',
    jsonb_build_object('proposal_id', p_proposal_id, 'grade_event_id', v_event_id, 'overridden', v_overridden,
                       'model', v_art.payload->>'model', 'prompt_version', v_art.payload->>'prompt_version'));
  return jsonb_build_object('ok', true, 'grade_event_id', v_event_id, 'verdict', v_verdict, 'overridden', v_overridden);
end $$;

-- ---- M6: rebuild_assessment requires write authority + active consent ----
create or replace function public.rebuild_assessment(p_child_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if not public.can_write_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = p_child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  delete from public.child_skill_assessment where child_id = p_child_id;
  insert into public.child_skill_assessment (child_id, skill_id, graded_count, correct_count, transfer_success_count, last_graded_at)
  select p_child_id, e.payload->>'skill_id',
         count(*)::int,
         count(*) filter (where e.payload->>'verdict' = 'correct')::int,
         count(*) filter (where e.payload->>'verdict' = 'correct')::int,
         max(e.created_at)
  from public.events e
  where e.kind = 'grade' and e.subject_child_id = p_child_id and e.payload ? 'skill_id'
  group by e.payload->>'skill_id';
  select count(*) into v_n from public.child_skill_assessment where child_id = p_child_id;
  return jsonb_build_object('ok', true, 'skills', v_n);
end $$;

-- ---- M7: approve_assignment moderates every delivered prompt ----
create or replace function public.approve_assignment(p_proposal_id uuid, p_override_title text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_art public.teaching_artifacts%rowtype;
  v_items jsonb; v_delivered jsonb; v_it jsonb; v_expected int; v_assignment_id uuid;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_art from public.teaching_artifacts where id = p_proposal_id and kind = 'assignment' and author_role = 'ai';
  if v_art.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_art.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_art.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;

  v_items := coalesce(v_art.payload->'items', '[]'::jsonb);
  v_delivered := '[]'::jsonb;
  for v_it in select * from jsonb_array_elements(v_items) loop
    v_expected := case v_it->>'operator'
      when '+' then (v_it->'operands'->>0)::int + (v_it->'operands'->>1)::int
      when '-' then (v_it->'operands'->>0)::int - (v_it->'operands'->>1)::int
      when '*' then (v_it->'operands'->>0)::int * (v_it->'operands'->>1)::int
      else null end;
    if v_expected is null or (v_it->>'correct_answer')::int <> v_expected then
      return jsonb_build_object('ok', false, 'error', 'invalid_items');
    end if;
    -- M7: moderate the child-facing prompt on the authoritative delivery path
    v_delivered := v_delivered || jsonb_build_array(jsonb_build_object(
      'operator', v_it->>'operator', 'operands', v_it->'operands', 'prompt', public.moderate_text(coalesce(v_it->>'prompt', ''))));
  end loop;

  insert into public.assignments (child_id, assigned_by, skill_id, title, status, items)
  values (v_art.child_id, auth.uid(), v_art.payload->>'skill_id',
          left(coalesce(p_override_title, v_art.payload->>'title', 'Practice'), 120), 'assigned', v_delivered)
  returning id into v_assignment_id;
  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, supersedes_id, visibility_scope)
  values (v_art.child_id, auth.uid(), case when public.is_my_child(v_art.child_id) then 'parent' else 'tutor' end,
          'assignment', 'math', jsonb_build_object('delivered_assignment_id', v_assignment_id), p_proposal_id, 'private');
  perform public.write_audit('ai.assignment.approve', v_art.child_id, 'allow',
    jsonb_build_object('proposal_id', p_proposal_id, 'assignment_id', v_assignment_id,
                       'model', v_art.payload->>'model', 'prompt_version', v_art.payload->>'prompt_version'));
  return jsonb_build_object('ok', true, 'assignment_id', v_assignment_id, 'items', jsonb_array_length(v_delivered));
end $$;
