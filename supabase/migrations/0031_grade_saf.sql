-- ============================================================================
-- 0031_grade_saf.sql — Phase 5 · 5c SEC-03 MUST-FIX: the child-facing SAF boundary.
-- LOCAL ONLY, additive. "The child sees nothing until a human confirms." can_view_child
-- (via is_my_child) is TRUE for the subject child's own minted login, so a logged-in child
-- could read their OWN pending, unmoderated grade_proposals/grade_jobs (raw AI read +
-- feedback) before any human confirms — a SAF violation. Fix: proposals/jobs are visible
-- ONLY to ADULT reviewers (the owning parent + granted tutors), NEVER the subject child.
-- The child's only grading surface remains the moderated `sent-to-child` feedback artifact
-- created inside confirm_image_grade.
-- ============================================================================

-- is_grade_reviewer: an adult who may VIEW this child (parent or granted tutor) with active
-- consent — but NOT the subject child themselves (whose auth.uid() = children.auth_user_id).
create or replace function public.is_grade_reviewer(p_child uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.can_view_child(p_child)
     and public.has_active_consent(p_child)
     and auth.uid() is distinct from (select c.auth_user_id from public.children c where c.id = p_child)
$$;
revoke all on function public.is_grade_reviewer(uuid) from public, anon;
grant execute on function public.is_grade_reviewer(uuid) to authenticated;

-- proposals + jobs: readable ONLY by adult reviewers (excludes the subject child)
drop policy if exists grade_proposals_select on public.grade_proposals;
create policy grade_proposals_select on public.grade_proposals for select to authenticated
  using (public.is_grade_reviewer(child_id));

drop policy if exists grade_jobs_select on public.grade_jobs;
create policy grade_jobs_select on public.grade_jobs for select to authenticated
  using (public.is_grade_reviewer(child_id));

-- list_grade_proposals: gate on is_grade_reviewer (adult-only), else uniform not_authorized
create or replace function public.list_grade_proposals(p_child_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if not public.is_grade_reviewer(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;

  select coalesce(jsonb_agg(row_to_json_obj order by created_at desc), '[]'::jsonb) into v_out
  from (
    select p.created_at,
      jsonb_build_object(
        'id', p.id, 'upload_id', p.upload_id, 'skill_id', p.skill_id,
        'read_answer', p.read_answer, 'confidence', p.confidence, 'feedback', p.feedback,
        'provider', p.provider, 'model', p.model_version, 'status', p.status, 'created_at', p.created_at,
        'solver_answer', public.grade_solve(j.problem_dna),
        'agreement', (p.read_answer is not distinct from public.grade_solve(j.problem_dna)),
        'detector_clean', coalesce(u.exif_stripped, false)
      ) as row_to_json_obj
    from public.grade_proposals p
    join public.grade_jobs j on j.id = p.job_id
    left join public.uploads u on u.id = p.upload_id
    where p.child_id = p_child_id and p.status = 'pending'
  ) s;
  return jsonb_build_object('ok', true, 'proposals', v_out);
end $$;
revoke all on function public.list_grade_proposals(uuid) from public, anon;
grant execute on function public.list_grade_proposals(uuid) to authenticated;
