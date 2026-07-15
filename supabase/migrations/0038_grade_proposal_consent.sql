-- 0038_grade_proposal_consent.sql — Phase 5 · B-F1. DIRECT consent re-check on
-- record_grade_proposal (KER-2: consent is a precondition re-verified at EVERY privileged
-- write, never inherited). Previously a proposal was only TRANSITIVELY consent-gated — it
-- trusted the job's creation-time consent check (submit_upload_for_grading). If consent was
-- revoked in the window between job creation and proposal recording, a proposal could still be
-- recorded for a now-revoked child. Now the subject child's active consent is re-verified at
-- RECORD time, BEFORE any write — fail-closed with NO side effects (no claimed→proposed flip,
-- no grade_proposals row, no cost settle). Forward-only. DEV/local only. Same signature +
-- grants as 0028; the ONLY change is the pre-write consent gate.
create or replace function public.record_grade_proposal(
  p_job_id uuid, p_read_answer int, p_confidence numeric, p_feedback text,
  p_misconception_id text, p_model text, p_provider text, p_cost numeric, p_latency int)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_job public.grade_jobs%rowtype; v_id uuid; v_child uuid;
begin
  -- B-F1 (KER-2): re-verify consent for the SUBJECT CHILD before any write. Consent is never
  -- inherited from the job's creation-time check — a revoke in the job→proposal window must
  -- block the proposal. Fail-closed with NO side effects (nothing has been written yet).
  select child_id into v_child from public.grade_jobs where id = p_job_id;
  if v_child is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not public.has_active_consent(v_child) then return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  -- atomically WIN the claimed→proposed transition: only the winner records + settles, so a
  -- stale-reclaim double (two workers on one job) yields exactly one proposal + one settle.
  update public.grade_jobs set status = 'proposed', actual_cost = p_cost, updated_at = now()
   where id = p_job_id and status = 'claimed'
  returning * into v_job;
  if v_job.id is null then return jsonb_build_object('ok', false, 'error', 'not_claimable'); end if;   -- already proposed/failed
  insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, confidence, feedback, misconception_id, model_version, provider, cost, latency_ms)
  values (p_job_id, v_job.child_id, v_job.upload_id, v_job.skill_id, p_read_answer, p_confidence,
          left(coalesce(p_feedback, ''), 2000), p_misconception_id, p_model, coalesce(p_provider, 'mock'), p_cost, p_latency)
  returning id into v_id;
  perform public.settle_grade_cost(v_job.child_id, v_job.reserved_cost, coalesce(p_cost, 0));
  return jsonb_build_object('ok', true, 'proposal_id', v_id);
end $$;
revoke all on function public.record_grade_proposal(uuid, int, numeric, text, text, text, text, numeric, int) from public, anon, authenticated;
grant execute on function public.record_grade_proposal(uuid, int, numeric, text, text, text, text, numeric, int) to service_role;
