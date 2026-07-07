-- ============================================================================
-- 0012_hardening2.sql — fixes from the 0011 self-review (SEC-03). LOCAL ONLY.
-- MUST be security-reviewed before any DEV/prod apply.
--
--   M7b (HIGH) — the assignment TITLE (AI-authored, child-facing) was delivered
--        unmoderated; run it through moderate_text like the item prompts (KER-5).
--   M5b (MED)  — make the "one grade per submission" guard race-proof with a
--        partial unique index (backstop for concurrent approvals).
--   DoS (MED)  — malformed/oversized client problem_dna (non-numeric operands,
--        int overflow) threw and aborted approve_grade/approve_assignment; make
--        the numeric extraction fail CLOSED (grade -> incorrect; item -> invalid).
-- ============================================================================

-- M5b: at most one authoritative grade event per submission (race backstop)
create unique index if not exists events_grade_submission_uniq
  on public.events ((payload->>'submission_id')) where kind = 'grade';

-- approve_grade: DoS-safe recompute + graceful loss-of-race
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
  if exists (select 1 from public.events where kind = 'grade' and (payload->>'submission_id')::uuid = v_sub.id) then
    return jsonb_build_object('ok', false, 'error', 'already_recorded');
  end if;

  -- H3 + DoS-safe: recompute from operands; bad DNA fails CLOSED to incorrect
  begin
    v_expected := case v_sub.problem_dna->>'operator'
      when '+' then (v_sub.problem_dna->'operands'->>0)::int + (v_sub.problem_dna->'operands'->>1)::int
      when '-' then (v_sub.problem_dna->'operands'->>0)::int - (v_sub.problem_dna->'operands'->>1)::int
      when '*' then (v_sub.problem_dna->'operands'->>0)::int * (v_sub.problem_dna->'operands'->>1)::int
      else null end;
  exception when others then v_expected := null;
  end;
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
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'already_recorded');   -- lost the race
end $$;

-- approve_assignment: moderate the TITLE too (M7b) + DoS-safe item validation
create or replace function public.approve_assignment(p_proposal_id uuid, p_override_title text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_art public.teaching_artifacts%rowtype;
  v_items jsonb; v_delivered jsonb; v_it jsonb; v_expected int; v_provided int; v_assignment_id uuid;
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
    begin
      v_expected := case v_it->>'operator'
        when '+' then (v_it->'operands'->>0)::int + (v_it->'operands'->>1)::int
        when '-' then (v_it->'operands'->>0)::int - (v_it->'operands'->>1)::int
        when '*' then (v_it->'operands'->>0)::int * (v_it->'operands'->>1)::int
        else null end;
      v_provided := (v_it->>'correct_answer')::int;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'invalid_items');   -- malformed DNA fails closed
    end;
    if v_expected is null or v_provided <> v_expected then
      return jsonb_build_object('ok', false, 'error', 'invalid_items');
    end if;
    v_delivered := v_delivered || jsonb_build_array(jsonb_build_object(
      'operator', v_it->>'operator', 'operands', v_it->'operands', 'prompt', public.moderate_text(coalesce(v_it->>'prompt', ''))));
  end loop;

  insert into public.assignments (child_id, assigned_by, skill_id, title, status, items)
  values (v_art.child_id, auth.uid(), v_art.payload->>'skill_id',
          left(public.moderate_text(coalesce(p_override_title, v_art.payload->>'title', 'Practice')), 120),  -- M7b: title moderated
          'assigned', v_delivered)
  returning id into v_assignment_id;
  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, supersedes_id, visibility_scope)
  values (v_art.child_id, auth.uid(), case when public.is_my_child(v_art.child_id) then 'parent' else 'tutor' end,
          'assignment', 'math', jsonb_build_object('delivered_assignment_id', v_assignment_id), p_proposal_id, 'private');
  perform public.write_audit('ai.assignment.approve', v_art.child_id, 'allow',
    jsonb_build_object('proposal_id', p_proposal_id, 'assignment_id', v_assignment_id,
                       'model', v_art.payload->>'model', 'prompt_version', v_art.payload->>'prompt_version'));
  return jsonb_build_object('ok', true, 'assignment_id', v_assignment_id, 'items', jsonb_array_length(v_delivered));
end $$;
