-- ============================================================================
-- 0029_grade_5b.sql — Phase 5 · 5b: the guardrailed adapter's DB seams. LOCAL ONLY,
-- additive. Joins the 5b SEC-03 review. The provider BORDER + local-first selection +
-- strict output schema live in code (_shared/provider-registry, grade-adapter); this
-- migration adds the DB pieces:
--   - claim_grade_jobs also returns the upload's storage_path so the worker can fetch the
--     bytes and hand them to the adapter INLINE (never a URL to any external party).
--   - per-ACCOUNT daily cap (a small multiple of the per-child cap) + an 80% spend alarm,
--     on top of the per-child cap. DOLLAR FIGURES ARE PLACEHOLDERS — set at the real-family/
--     provider gate against real per-call pricing + the ~$15-19/family/mo economics.
--   - a submit rate-limit (bursts refused).
--   - confirm_image_grade gains p_corrected_read_answer: a human may FIX a misread; the
--     deterministic solver then arbitrates the CORRECTED value. The raw AI read stays
--     immutable on the proposal; the correction is recorded on the grade Event + audit.
--
-- No new child-keyed tables (the account cap is computed from the per-child ledgers), so
-- AC-6 / purge_child are unchanged. DEFINER HYGIENE preserved: the ledger helpers stay
-- SECURITY DEFINER and revoked from all client roles (the 5a HIGH lock).
-- ============================================================================

-- ---- claim_grade_jobs: also return the upload's storage_path (for inline byte fetch) -----
drop function if exists public.claim_grade_jobs(int);
create or replace function public.claim_grade_jobs(p_limit int default 20)
returns table (id uuid, child_id uuid, upload_id uuid, skill_id text, problem_dna jsonb, storage_path text)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
  update public.grade_jobs q set status = 'claimed', attempts = q.attempts + 1, updated_at = now()
   where q.id in (
     select c.id from public.grade_jobs c
      where c.status = 'pending'
         or (c.status = 'claimed' and c.updated_at < now() - interval '5 minutes')  -- reclaim a dead worker's job
      order by c.created_at limit greatest(coalesce(p_limit, 20), 1) for update skip locked)
  returning q.id, q.child_id, q.upload_id, q.skill_id, q.problem_dna,
            (select u.storage_path from public.uploads u where u.id = q.upload_id);
end $$;
revoke all on function public.claim_grade_jobs(int) from public, anon, authenticated;
grant execute on function public.claim_grade_jobs(int) to service_role;

-- ---- per-account daily cap (PLACEHOLDER multiple; set for real at the gate) ----------------
create or replace function public.grade_account_daily_cap() returns numeric
language sql immutable set search_path = '' as $$ select public.grade_daily_cap() * 4 $$;
revoke all on function public.grade_account_daily_cap() from public, anon, authenticated;

-- ---- reserve_grade_budget: per-CHILD cap AND per-ACCOUNT cap + 80% spend alarm ------------
create or replace function public.reserve_grade_budget(p_child uuid, p_estimate numeric)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_parent uuid; v_child_ok boolean; v_acct_used numeric; v_acct_cap numeric;
begin
  select parent_id into v_parent from public.children where id = p_child;
  v_acct_cap := public.grade_account_daily_cap();
  insert into public.grade_cost_ledger (child_id, day, reserved) values (p_child, current_date, 0)
    on conflict (child_id, day) do nothing;
  -- account aggregate: reserved+settled across ALL the parent's children today
  select coalesce(sum(l.reserved + l.settled), 0) into v_acct_used
    from public.grade_cost_ledger l join public.children c on c.id = l.child_id
   where c.parent_id = v_parent and l.day = current_date;
  if v_acct_used + p_estimate > v_acct_cap then return false; end if;             -- account cap (fail closed)
  update public.grade_cost_ledger
     set reserved = reserved + p_estimate
   where child_id = p_child and day = current_date
     and reserved + settled + p_estimate <= public.grade_daily_cap()             -- per-child cap (fail closed)
  returning true into v_child_ok;
  if not coalesce(v_child_ok, false) then return false; end if;
  -- spend alarm at 80% of the ACCOUNT cap (audited, non-blocking)
  if v_acct_used + p_estimate >= 0.8 * v_acct_cap then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (coalesce(v_parent, '00000000-0000-0000-0000-000000000000'), 'grade.spend_alarm', p_child, 'allow',
            jsonb_build_object('account_used', v_acct_used + p_estimate, 'account_cap', v_acct_cap, 'threshold', 0.8));
  end if;
  return true;
end $$;
revoke all on function public.reserve_grade_budget(uuid, numeric) from public, anon, authenticated;

-- ---- submit_upload_for_grading: add a per-child submit RATE LIMIT ------------------------
create or replace function public.submit_upload_for_grading(
  p_upload_id uuid, p_skill_id text, p_problem_dna jsonb, p_client_job_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_up public.uploads%rowtype; v_id uuid; v_estimate numeric := 1; v_recent int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_up from public.uploads where id = p_upload_id;
  if v_up.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_upload'); end if;
  if not public.can_write_child(v_up.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_up.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;

  select id into v_id from public.grade_jobs where child_id = v_up.child_id and client_job_id = p_client_job_id;
  if v_id is not null then return jsonb_build_object('ok', true, 'job_id', v_id, 'duplicate', true); end if;

  -- rate limit: bound how many grade jobs one child can enqueue per minute (abuse/cost)
  select count(*) into v_recent from public.grade_jobs
   where child_id = v_up.child_id and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;

  if not public.reserve_grade_budget(v_up.child_id, v_estimate) then
    return jsonb_build_object('ok', false, 'error', 'budget_exceeded'); end if;

  insert into public.grade_jobs (child_id, upload_id, skill_id, problem_dna, reserved_cost, client_job_id)
  values (v_up.child_id, p_upload_id, p_skill_id, coalesce(p_problem_dna, '{}'::jsonb), v_estimate, p_client_job_id)
  returning id into v_id;
  perform public.write_audit('grade.submit', v_up.child_id, 'allow', jsonb_build_object('job_id', v_id, 'upload_id', p_upload_id, 'skill_id', p_skill_id));
  return jsonb_build_object('ok', true, 'job_id', v_id);
end $$;
revoke all on function public.submit_upload_for_grading(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.submit_upload_for_grading(uuid, text, jsonb, uuid) to authenticated;

-- ---- confirm_image_grade: + p_corrected_read_answer (human fixes a misread) --------------
-- The raw AI read (v_p.read_answer) stays IMMUTABLE on the proposal. If the human supplies a
-- correction, the deterministic solver arbitrates the CORRECTED value; the grade Event records
-- raw_read, corrected_read, the effective read used, and a corrected flag. Still the ONLY
-- record path; still 100% human.
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
  select * into v_p from public.grade_proposals where id = p_proposal_id;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_p.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_p.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  if v_p.status <> 'pending' then return jsonb_build_object('ok', true, 'idempotent', true, 'grade_event_id', v_p.grade_event_id); end if;
  select * into v_job from public.grade_jobs where id = v_p.job_id;

  -- THE ARBITER: solver ground truth from the assigned problem, NEVER the image. The human may
  -- correct the READ (OCR fix); the solver then arbitrates the corrected value.
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
