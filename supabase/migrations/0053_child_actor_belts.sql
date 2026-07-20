-- ============================================================================
-- 0053_child_actor_belts.sql — BRIELLE LAUNCH · the last code gate before hosting a real child.
-- Closes the ONE root cause the final consolidated review found: is_my_child() is TRUE for the
-- child's OWN minted login (auth_user_id = auth.uid()), so write paths gated only on
-- is_my_child / can_write_child WITHOUT a `not is_child_actor_self()` belt let the child login act
-- as the PARENT on their own record. Additive WITH CHECK / USING belts only — NO change to
-- can_view_child / can_write_child / is_my_child / is_group_member / is_group_leader. Forward-only.
-- DEV/local only.
--
-- BLOCKER (confirmed, legally serious): a child login could self-issue a can_write tutor_grant to
-- an arbitrary adult AND (via log_tutor_disclosure) forge an immutable consent_ledger 'disclosure'.
-- The PARENT must be the SOLE issuer of a disclosure grant.
-- ============================================================================

-- ---- (1) BLOCKER: tutor_grants — the child can NEVER issue or manage a disclosure grant ----
drop policy tutor_grants_insert on public.tutor_grants;
create policy tutor_grants_insert on public.tutor_grants
  for insert to authenticated
  with check (granted_by = auth.uid() and public.is_my_child(child_id)
              and not public.is_child_actor_self()          -- 0053 BLOCKER belt: only the PARENT issues a grant (never the child login)
              and origin = 'parent_direct');
drop policy tutor_grants_update on public.tutor_grants;
create policy tutor_grants_update on public.tutor_grants
  for update to authenticated
  using (granted_by = auth.uid() and not public.is_child_actor_self() and origin = 'parent_direct')
  with check (granted_by = auth.uid() and not public.is_child_actor_self() and origin = 'parent_direct');

-- ---- (2) assignments — assigning is an ADULT action, and never before consent (self-assign belt) ----
-- assignments_insert (0004) + assignments_update (0006) gated only on can_write_child/assigned_by, with
-- no child-actor belt and no consent gate — a child could self-assign, and either could write to a
-- consent-null child on the direct PostgREST path. Add both belts (parity with every RPC write path).
drop policy assignments_insert on public.assignments;
create policy assignments_insert on public.assignments
  for insert to authenticated
  with check (public.can_write_child(child_id) and assigned_by = auth.uid()
              and not public.is_child_actor_self()
              and public.has_active_consent(child_id));
drop policy assignments_update on public.assignments;
create policy assignments_update on public.assignments
  for update to authenticated
  using (public.can_write_child(child_id) and not public.is_child_actor_self() and public.has_active_consent(child_id))
  with check (public.can_write_child(child_id) and assigned_by = auth.uid()
              and not public.is_child_actor_self()
              and public.has_active_consent(child_id));

-- ---- (3) teaching_artifacts_insert — add the consent gate (defense-in-depth; the child-actor belt is
-- already present at 0037:34, and the SELECT policy 0006:125 already consent-gates; the INSERT was the
-- outlier). No child-DATA write before VPC, on the direct client path too. ----
drop policy teaching_artifacts_insert on public.teaching_artifacts;
create policy teaching_artifacts_insert on public.teaching_artifacts
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and not public.is_child_actor_self()
    and public.has_active_consent(child_id)          -- 0053: no child-DATA write before VPC (parity with the SELECT policy + every RPC write path)
    and (
      (author_role = 'parent' and public.is_my_child(child_id))
      or (author_role = 'tutor' and exists (
            select 1 from public.tutor_grants tg
            where tg.child_id = teaching_artifacts.child_id
              and tg.tutor_id = auth.uid() and tg.active and tg.can_write))
    )
  );

-- ---- (3b) groups_insert — the one direct-write surface that create_group already belts but the raw
-- policy did not: a child could direct-INSERT a nominal group (inert junk/spam, no escalation — confirm_add
-- needs the target's parent, join_group rejects the child) — close it for parity. Adults (the academy
-- admin / a class-creating parent do a legit client insert) stay through created_by = auth.uid(). ----
drop policy groups_insert on public.groups;
create policy groups_insert on public.groups for insert to authenticated
  with check (created_by = auth.uid() and not public.actor_is_deleted(auth.uid()) and not public.is_child_actor_self());

-- ---- (4) leave_group — the child cannot self-remove from a group (parent-in-the-loop) ----
-- Identical to 0046 except the added is_child_actor_self belt after the auth check. Every other
-- membership mutation (join_group, remove_member, flag_member) already blocks the child actor.
create or replace function public.leave_group(p_group_id uuid, p_member_child_id uuid, p_member_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_role text;
  v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- 0053: parent-in-the-loop — a child cannot self-remove
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  if not (p_member_child_id is not null and public.is_my_child(p_member_child_id)) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id, role into v_membership_id, v_role from public.memberships
   where group_id = p_group_id
     and member_child_id is not distinct from p_member_child_id
     and member_actor_id is not distinct from p_member_actor_id and active;
  if v_membership_id is null then return jsonb_build_object('ok', false, 'error', 'not_a_member'); end if;

  update public.memberships set active = false, left_at = now() where id = v_membership_id;
  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('membership', v_uid, p_member_child_id, p_group_id,
          jsonb_build_object('action', 'leave', 'membership_id', v_membership_id))
  returning id into v_event_id;
  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
  values (v_event_id, 'leave', p_group_id, p_member_child_id, p_member_actor_id, coalesce(v_role, 'member'),
          'leave:' || v_membership_id::text || ':' || v_event_id::text, 'pending');

  if v_group.purpose in ('class','team') and p_member_child_id is not null then
    perform public.reconcile_group_grant(p_group_id, p_member_child_id);
  end if;
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;
revoke all on function public.leave_group(uuid, uuid, uuid) from public, anon;
grant execute on function public.leave_group(uuid, uuid, uuid) to authenticated;

-- ---- (5) image-grade approval is an ADULT action — the subject child cannot approve/reject their own
-- AI grade (AI-3: no AI grade becomes record until a HUMAN approves — that human must be an adult).
-- confirm_image_grade (0029, the latest 3-arg) + reject_image_grade (0028). Identical bodies + the belt.
-- FIRST drop the superseded UNBELTED 2-arg overload (0028) so it cannot be a child's escape hatch — a
-- PostgREST call with 2 named params now falls through to the belted 3-arg (the extra arg defaults). ----
drop function if exists public.confirm_image_grade(uuid, text);
create or replace function public.confirm_image_grade(p_proposal_id uuid, p_override_feedback text default null, p_corrected_read_answer int default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_p public.grade_proposals%rowtype; v_job public.grade_jobs%rowtype;
  v_solver int; v_effective int; v_correct boolean; v_verdict text; v_feedback text; v_event_id uuid;
  v_overridden boolean; v_corrected boolean;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- 0053: a child cannot approve their own AI grade
  select * into v_p from public.grade_proposals where id = p_proposal_id;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_p.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_p.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  if v_p.status <> 'pending' then return jsonb_build_object('ok', true, 'idempotent', true, 'grade_event_id', v_p.grade_event_id); end if;
  select * into v_job from public.grade_jobs where id = v_p.job_id;

  v_solver := public.grade_solve(v_job.problem_dna);
  v_corrected := p_corrected_read_answer is not null and p_corrected_read_answer is distinct from v_p.read_answer;
  v_effective := coalesce(p_corrected_read_answer, v_p.read_answer);
  v_correct := (v_effective is not distinct from v_solver);
  v_verdict := case when v_correct then 'correct' else 'incorrect' end;
  v_overridden := p_override_feedback is not null;
  v_feedback := public.moderate_text(coalesce(p_override_feedback, v_p.feedback, ''));

  insert into public.events (kind, author_actor_id, subject_child_id, context_ref_kind, context_ref_id, payload)
  values ('grade', auth.uid(), v_p.child_id, 'upload', v_p.upload_id,
          jsonb_build_object('source', 'handwriting', 'verdict', v_verdict, 'score', case when v_correct then 100 else 0 end,
                             'skill_id', v_p.skill_id, 'upload_id', v_p.upload_id, 'proposal_id', v_p.id,
                             'raw_read', v_p.read_answer, 'corrected_read', p_corrected_read_answer, 'effective_read', v_effective,
                             'corrected', v_corrected, 'solver_answer', v_solver, 'overridden', v_overridden,
                             'model', v_p.model_version, 'provider', v_p.provider))
  returning id into v_event_id;

  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, target_kind, target_id, visibility_scope)
  values (v_p.child_id, auth.uid(),
          case when public.is_my_child(v_p.child_id) then 'parent' else 'tutor' end,
          'feedback', 'math', jsonb_build_object('feedback', v_feedback, 'grade_event_id', v_event_id),
          'upload', v_p.upload_id, 'sent-to-child');

  insert into public.child_skill_assessment (child_id, skill_id, graded_count, correct_count, transfer_success_count, last_graded_at)
  values (v_p.child_id, v_p.skill_id, 1, case when v_correct then 1 else 0 end, case when v_correct then 1 else 0 end, now())
  on conflict (child_id, skill_id) do update set
    graded_count = public.child_skill_assessment.graded_count + 1,
    correct_count = public.child_skill_assessment.correct_count + case when v_correct then 1 else 0 end,
    transfer_success_count = public.child_skill_assessment.transfer_success_count + case when v_correct then 1 else 0 end,
    last_graded_at = now(), updated_at = now();

  update public.grade_proposals
     set status = case when v_overridden or v_corrected then 'overridden' else 'confirmed' end,
         grade_event_id = v_event_id, confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_proposal_id;

  perform public.write_audit('grade.confirm', v_p.child_id, 'allow',
    jsonb_build_object('proposal_id', p_proposal_id, 'grade_event_id', v_event_id, 'verdict', v_verdict,
                       'corrected', v_corrected, 'raw_read', v_p.read_answer, 'effective_read', v_effective,
                       'overridden', v_overridden, 'provider', v_p.provider, 'model', v_p.model_version));
  return jsonb_build_object('ok', true, 'grade_event_id', v_event_id, 'verdict', v_verdict, 'corrected', v_corrected, 'overridden', v_overridden);
end $$;
revoke all on function public.confirm_image_grade(uuid, text, int) from public, anon;
grant execute on function public.confirm_image_grade(uuid, text, int) to authenticated;

create or replace function public.reject_image_grade(p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_p public.grade_proposals%rowtype;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- 0053: a child cannot reject their own AI grade
  select * into v_p from public.grade_proposals where id = p_proposal_id;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_p.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  update public.grade_proposals set status = 'rejected', confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_proposal_id and status = 'pending';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.reject_image_grade(uuid) from public, anon;
grant execute on function public.reject_image_grade(uuid) to authenticated;
