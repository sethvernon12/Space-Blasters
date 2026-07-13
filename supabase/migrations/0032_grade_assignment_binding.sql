-- ============================================================================
-- 0032_grade_assignment_binding.sql — Phase 5 · 5e: bind a graded problem to a real
-- assignment. LOCAL ONLY, additive. Closes the 5b-review LOW (problem_dna was free-form
-- caller input at submit). The trusted problem now lives on the ASSIGNMENT (authored by
-- the adult who created it), and submit_upload_for_grading DERIVES it server-side —
-- a client-supplied problem is impossible (the param is gone), and a cross-family /
-- not-this-child / problem-less binding FAILS CLOSED. The deterministic solver still
-- arbitrates from that trusted problem, never the image.
-- ============================================================================

-- the structured single-problem spec on the assignment (one skill-tagged problem, MVP):
-- {operator, a, b, [local_read for the dev reader]}. NULL = not gradeable.
alter table public.assignments add column if not exists problem_dna jsonb;

-- submit_upload_for_grading now takes an ASSIGNMENT id (not a problem). skill_id + the
-- problem are derived from the assignment; the old (uuid,text,jsonb,uuid) signature is gone.
drop function if exists public.submit_upload_for_grading(uuid, text, jsonb, uuid);
create or replace function public.submit_upload_for_grading(p_upload_id uuid, p_assignment_id uuid, p_client_job_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_up public.uploads%rowtype; v_asg public.assignments%rowtype; v_id uuid; v_estimate numeric := 1; v_recent int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_up from public.uploads where id = p_upload_id;
  if v_up.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_upload'); end if;
  if not public.can_write_child(v_up.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_up.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;

  -- the problem is DERIVED from the assignment (trusted, adult-authored), NEVER the client.
  select * into v_asg from public.assignments where id = p_assignment_id;
  if v_asg.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_assignment'); end if;               -- fail closed
  if v_asg.child_id is distinct from v_up.child_id then return jsonb_build_object('ok', false, 'error', 'binding_mismatch'); end if; -- not-this-child / cross-family
  if v_asg.problem_dna is null then return jsonb_build_object('ok', false, 'error', 'no_problem'); end if;             -- problem-less binding fails closed

  select id into v_id from public.grade_jobs where child_id = v_up.child_id and client_job_id = p_client_job_id;
  if v_id is not null then return jsonb_build_object('ok', true, 'job_id', v_id, 'duplicate', true); end if;

  select count(*) into v_recent from public.grade_jobs where child_id = v_up.child_id and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;

  if not public.reserve_grade_budget(v_up.child_id, v_estimate) then
    return jsonb_build_object('ok', false, 'error', 'budget_exceeded'); end if;

  insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, reserved_cost, client_job_id)
  values (v_up.child_id, p_upload_id, v_asg.skill_id, v_asg.problem_dna, v_estimate, p_client_job_id)   -- skill + problem from the assignment
  returning id into v_id;
  perform public.write_audit('grade.submit', v_up.child_id, 'allow',
    jsonb_build_object('job_id', v_id, 'upload_id', p_upload_id, 'assignment_id', p_assignment_id, 'skill_id', v_asg.skill_id));
  return jsonb_build_object('ok', true, 'job_id', v_id);
end $$;
revoke all on function public.submit_upload_for_grading(uuid, uuid, uuid) from public, anon;
grant execute on function public.submit_upload_for_grading(uuid, uuid, uuid) to authenticated;
