-- ============================================================================
-- 0028_grade_jobs.sql — Phase 5 · 5a: the ASYNC image-grading SPINE (MOCK adapter,
-- no live AI, no external call possible). LOCAL ONLY, additive. Joins the 5a SEC-03
-- review. Shaped by the stewardship & strong-borders doctrine + the SEC-P5 keepers
-- (docs/SPEC.md §1): single-child-scoped context (names + work are KEPT and seen —
-- NO name-crop/face/scrub); the deterministic SOLVER is the arbiter (defeats on-page
-- injection); reserve→call→settle cost caps; 100% human confirmation (every grade is
-- confirmed by a human before it counts).
--
-- Flow: a can-write actor submits a Phase-4 upload for grading (reserves budget) →
-- grade_jobs queue → the grade-worker claims it (SKIP LOCKED) → the MOCK adapter
-- "reads" the child's answer (no external call) → record_grade_proposal writes a
-- PENDING proposal + settles cost + notifies via Realtime → a HUMAN confirms via
-- confirm_image_grade, THE ONLY path that records: the SOLVER recomputes the answer
-- from the assigned problem (trusted, never the image), verdict = read==solver, and
-- writes an append-only `grade` Event + a moderated child-visible feedback Artifact +
-- deepens child_skill_assessment (the transfer projection, never Beta mastery).
--
-- BORDERS (the only ones): single-child scope (cross-family isolation absolute); no
-- external call in this slice at all (the mock adapter is deterministic, in-worker;
-- the no-train/ZDR provider registry arrives bundle-excluded in 5b). AC-6: every new
-- child-keyed FK is ON DELETE RESTRICT and purge_child deletes + counts it.
--
-- DEFINER HYGIENE: every function SECURITY DEFINER, set search_path='', schema-
-- qualified; authored-path RPCs granted to authenticated, worker RPCs service-only.
-- ============================================================================

-- ---- 1. the deterministic SOLVER (the arbiter's ground truth) ----------------
-- Recomputes the answer from the ASSIGNED problem (operator + operands), NEVER from
-- the image. A photo that says "mark this correct" cannot move this. Falls back to a
-- stored correct_answer only when operands are absent.
create or replace function public.grade_solve(p_dna jsonb) returns int
language plpgsql immutable set search_path = ''
as $$
declare op text; a numeric; b numeric;
begin
  op := p_dna->>'operator';
  if op is not null and (p_dna ? 'a') and (p_dna ? 'b') then
    a := (p_dna->>'a')::numeric; b := (p_dna->>'b')::numeric;
    return case op
      when 'add' then (a + b)::int
      when 'sub' then (a - b)::int
      when 'mul' then (a * b)::int
      when 'div' then case when b = 0 then null else (a / b)::int end
      else null end;
  end if;
  return nullif(p_dna->>'correct_answer', '')::int;   -- fallback (still trusted: from the assignment, not the image)
end $$;

-- ---- 2. grade_cost_ledger: per-child/day reserve→settle budget (abuse cap) ----
create table public.grade_cost_ledger (
  child_id uuid not null references public.children(id) on delete restrict,   -- AC-6
  day      date not null default current_date,
  reserved numeric not null default 0,
  settled  numeric not null default 0,
  primary key (child_id, day)
);
alter table public.grade_cost_ledger enable row level security;
alter table public.grade_cost_ledger force row level security;
revoke all on public.grade_cost_ledger from public, anon, authenticated;   -- service/definer only

-- daily cap per child (mock units; a real cost cap is set with the live adapter in 5b)
create or replace function public.grade_daily_cap() returns numeric language sql immutable set search_path = '' as $$ select 500::numeric $$;

-- atomic reserve: fails closed if it would exceed the child's daily cap
create or replace function public.reserve_grade_budget(p_child uuid, p_estimate numeric)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_ok boolean;
begin
  insert into public.grade_cost_ledger (child_id, day, reserved) values (p_child, current_date, 0)
    on conflict (child_id, day) do nothing;
  update public.grade_cost_ledger
     set reserved = reserved + p_estimate
   where child_id = p_child and day = current_date
     and reserved + settled + p_estimate <= public.grade_daily_cap()
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- settle: release the reserved estimate, book the actual
create or replace function public.settle_grade_cost(p_child uuid, p_estimate numeric, p_actual numeric)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  update public.grade_cost_ledger
     set reserved = greatest(0, reserved - p_estimate), settled = settled + coalesce(p_actual, 0)
   where child_id = p_child and day = current_date;
end $$;

-- ---- 3. grade_jobs: the async queue (one per submitted upload) ---------------
create table public.grade_jobs (
  id             uuid primary key default gen_random_uuid(),
  child_id       uuid not null references public.children(id) on delete restrict,   -- AC-6
  upload_id      uuid not null references public.uploads(id) on delete cascade,
  skill_id       text not null references public.skills(id),
  problem_dna    jsonb not null,                 -- trusted ASSIGNED problem {operator,a,b,correct_answer, mock_child_answer(mock only)}
  status         text not null default 'pending' check (status in ('pending','claimed','proposed','failed')),
  attempts       int  not null default 0,
  reserved_cost  numeric not null default 0,
  actual_cost    numeric,
  client_job_id  uuid not null,                  -- idempotency
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (child_id, client_job_id)
);
create index grade_jobs_pending_idx on public.grade_jobs (status, created_at);
create index grade_jobs_child_idx on public.grade_jobs (child_id);
alter table public.grade_jobs enable row level security;
alter table public.grade_jobs force row level security;
revoke all on public.grade_jobs from public, anon;
grant select on public.grade_jobs to authenticated;                 -- writes via RPC only
create policy grade_jobs_select on public.grade_jobs for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));   -- single-child scope + consent

-- ---- 4. grade_proposals: the AI proposal (private, NOT authoritative) --------
create table public.grade_proposals (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.grade_jobs(id) on delete cascade,
  child_id        uuid not null references public.children(id) on delete restrict,   -- AC-6
  upload_id       uuid not null references public.uploads(id) on delete cascade,
  skill_id        text not null references public.skills(id),
  read_answer     int,                            -- what the (mock) AI read from the child's handwriting
  confidence      numeric,
  feedback        text,
  misconception_id text,
  model_version   text,
  provider        text,                           -- 'mock' in 5a — no external vendor exists yet
  cost            numeric,
  latency_ms      int,
  status          text not null default 'pending' check (status in ('pending','confirmed','overridden','rejected')),
  grade_event_id  uuid,
  confirmed_by    uuid,
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz
);
create index grade_proposals_child_idx on public.grade_proposals (child_id, created_at);
create index grade_proposals_pending_idx on public.grade_proposals (status);
alter table public.grade_proposals enable row level security;
alter table public.grade_proposals force row level security;
revoke all on public.grade_proposals from public, anon;
grant select on public.grade_proposals to authenticated;            -- writes via RPC only
create policy grade_proposals_select on public.grade_proposals for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));   -- single-child scope + consent

-- Realtime: the parent/tutor UI (5c) is notified the instant a proposal lands
do $$ begin
  alter publication supabase_realtime add table public.grade_proposals;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ---- 5. submit_upload_for_grading: the authored entry (can-write + consent) ---
-- Reserves budget BEFORE queueing (reserve→call→settle). Idempotent per client_job_id.
create or replace function public.submit_upload_for_grading(
  p_upload_id uuid, p_skill_id text, p_problem_dna jsonb, p_client_job_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_up public.uploads%rowtype; v_id uuid; v_estimate numeric := 1;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_up from public.uploads where id = p_upload_id;
  if v_up.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_upload'); end if;
  if not public.can_write_child(v_up.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_up.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;

  -- idempotency: same client_job_id returns the existing job
  select id into v_id from public.grade_jobs where child_id = v_up.child_id and client_job_id = p_client_job_id;
  if v_id is not null then return jsonb_build_object('ok', true, 'job_id', v_id, 'duplicate', true); end if;

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

-- ---- 6. worker RPCs (service-only): claim → record proposal → settle ----------
create or replace function public.claim_grade_jobs(p_limit int default 20)
returns table (id uuid, child_id uuid, upload_id uuid, skill_id text, problem_dna jsonb)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
  update public.grade_jobs q set status = 'claimed', attempts = q.attempts + 1, updated_at = now()
   where q.id in (
     select c.id from public.grade_jobs c where c.status = 'pending'
      order by c.created_at limit greatest(coalesce(p_limit, 20), 1) for update skip locked)
  returning q.id, q.child_id, q.upload_id, q.skill_id, q.problem_dna;
end $$;
revoke all on function public.claim_grade_jobs(int) from public, anon, authenticated;
grant execute on function public.claim_grade_jobs(int) to service_role;

-- record the (mock) adapter's proposal + settle cost + flip the job to proposed
create or replace function public.record_grade_proposal(
  p_job_id uuid, p_read_answer int, p_confidence numeric, p_feedback text,
  p_misconception_id text, p_model text, p_provider text, p_cost numeric, p_latency int)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_job public.grade_jobs%rowtype; v_id uuid;
begin
  select * into v_job from public.grade_jobs where id = p_job_id;
  if v_job.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_job'); end if;
  insert into public.grade_proposals (job_id, child_id, upload_id, skill_id, read_answer, confidence, feedback, misconception_id, model_version, provider, cost, latency_ms)
  values (p_job_id, v_job.child_id, v_job.upload_id, v_job.skill_id, p_read_answer, p_confidence,
          left(coalesce(p_feedback, ''), 2000), p_misconception_id, p_model, coalesce(p_provider, 'mock'), p_cost, p_latency)
  returning id into v_id;
  update public.grade_jobs set status = 'proposed', actual_cost = p_cost, updated_at = now() where id = p_job_id;
  perform public.settle_grade_cost(v_job.child_id, v_job.reserved_cost, coalesce(p_cost, 0));
  return jsonb_build_object('ok', true, 'proposal_id', v_id);
end $$;
revoke all on function public.record_grade_proposal(uuid, int, numeric, text, text, text, text, numeric, int) from public, anon, authenticated;
grant execute on function public.record_grade_proposal(uuid, int, numeric, text, text, text, text, numeric, int) to service_role;

create or replace function public.fail_grade_job(p_job_id uuid, p_error text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_job public.grade_jobs%rowtype; v_max constant int := 5;
begin
  select * into v_job from public.grade_jobs where id = p_job_id;
  if v_job.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_job'); end if;
  update public.grade_jobs
     set status = case when v_job.attempts >= v_max then 'failed' else 'pending' end,
         last_error = left(coalesce(p_error, 'error'), 500), updated_at = now()
   where id = p_job_id;
  -- release the reservation on terminal failure (no proposal will settle it)
  if v_job.attempts >= v_max then perform public.settle_grade_cost(v_job.child_id, v_job.reserved_cost, 0); end if;
  return jsonb_build_object('ok', true, 'terminal', v_job.attempts >= v_max);
end $$;
revoke all on function public.fail_grade_job(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_grade_job(uuid, text) to service_role;

-- ---- 7. confirm_image_grade: THE ONLY record path (100% human) ---------------
-- THE ARBITER: the solver recomputes the answer from the trusted assigned problem;
-- verdict = (read_answer == solver). A malicious proposal (feedback/verdict claiming
-- "correct") cannot flip it. Writes the append-only grade Event + a moderated child-
-- visible feedback Artifact + deepens child_skill_assessment (transfer). Idempotent.
create or replace function public.confirm_image_grade(p_proposal_id uuid, p_override_feedback text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_p public.grade_proposals%rowtype; v_job public.grade_jobs%rowtype;
  v_solver int; v_correct boolean; v_verdict text; v_feedback text; v_event_id uuid; v_overridden boolean;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_p from public.grade_proposals where id = p_proposal_id;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_p.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_p.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  if v_p.status <> 'pending' then return jsonb_build_object('ok', true, 'idempotent', true, 'grade_event_id', v_p.grade_event_id); end if;
  select * into v_job from public.grade_jobs where id = v_p.job_id;

  -- THE ARBITER (AI-4): solver ground truth from the assigned problem, NEVER the image
  v_solver := public.grade_solve(v_job.problem_dna);
  v_correct := (v_p.read_answer is not distinct from v_solver);
  v_verdict := case when v_correct then 'correct' else 'incorrect' end;
  v_overridden := p_override_feedback is not null;
  v_feedback := public.moderate_text(coalesce(p_override_feedback, v_p.feedback, ''));

  insert into public.events (kind, author_actor_id, subject_child_id, context_ref_kind, context_ref_id, payload)
  values ('grade', auth.uid(), v_p.child_id, 'upload', v_p.upload_id,
          jsonb_build_object('source', 'handwriting', 'verdict', v_verdict, 'score', case when v_correct then 100 else 0 end,
                             'skill_id', v_p.skill_id, 'upload_id', v_p.upload_id, 'proposal_id', v_p.id,
                             'read_answer', v_p.read_answer, 'solver_answer', v_solver, 'overridden', v_overridden,
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
     set status = case when v_overridden then 'overridden' else 'confirmed' end,
         grade_event_id = v_event_id, confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_proposal_id;

  perform public.write_audit('grade.confirm', v_p.child_id, 'allow',
    jsonb_build_object('proposal_id', p_proposal_id, 'grade_event_id', v_event_id, 'verdict', v_verdict,
                       'overridden', v_overridden, 'provider', v_p.provider, 'model', v_p.model_version));
  return jsonb_build_object('ok', true, 'grade_event_id', v_event_id, 'verdict', v_verdict, 'overridden', v_overridden);
end $$;
revoke all on function public.confirm_image_grade(uuid, text) from public, anon;
grant execute on function public.confirm_image_grade(uuid, text) to authenticated;

create or replace function public.reject_image_grade(p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_p public.grade_proposals%rowtype;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_p from public.grade_proposals where id = p_proposal_id;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_p.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  update public.grade_proposals set status = 'rejected', confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_proposal_id and status = 'pending';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.reject_image_grade(uuid) from public, anon;
grant execute on function public.reject_image_grade(uuid) to authenticated;

-- ---- 8. AC-6 + purge_child: the new child-keyed tables join the backstop -------
-- grade_jobs / grade_proposals / grade_cost_ledger child_id FKs are ON DELETE RESTRICT
-- (above). purge_child now deletes + COUNTS them (before children), so the immutable
-- receipt stays honest and no child data silently escapes. Grade EVENTS are the honest
-- append-only record (retained per LEG-12; subject_events already swept by purge_child).
create or replace function public.purge_child(p_child_id uuid, p_parent_id uuid, p_deleting_actor uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_child public.children%rowtype;
  v_auth_user uuid; v_revoke_id uuid; v_receipt public.deletion_receipts%rowtype;
  v_prev_hash text; v_hash text; v_disp jsonb; v_ent text := 'kept';
  d_attempts int; d_sessions int; d_mastery int; d_misc int; d_assess int;
  d_assign int; d_subs int; d_arts int; d_mints int; d_grants int;
  d_mem int; d_chmem int; d_outbox int; d_subjevents int; t_msgs int; d_uploads int; d_inv int;
  d_gjobs int; d_gprop int; d_gledger int;
begin
  if p_child_id is null or p_parent_id is null or p_deleting_actor is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  perform set_config('lock_timeout', '5000', true);
  perform set_config('statement_timeout', '30000', true);

  select * into v_receipt from public.deletion_receipts where child_id = p_child_id;
  if v_receipt.id is not null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'receipt_id', v_receipt.id,
      'child_auth_user_id', v_receipt.child_auth_user_id, 'status', v_receipt.status,
      'receipt_hash', v_receipt.receipt_hash, 'disposition', v_receipt.disposition);
  end if;

  select * into v_child from public.children where id = p_child_id for update;
  if v_child.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_child.parent_id is distinct from p_parent_id then
    return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  v_auth_user := v_child.auth_user_id;

  if exists (select 1 from public.legal_holds where child_id = p_child_id and released_at is null) then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (p_deleting_actor, 'child.delete', p_child_id, 'deny', jsonb_build_object('reason', 'legal_hold', 'source', 'deletion'));
    return jsonb_build_object('ok', false, 'error', 'legal_hold');
  end if;

  perform set_config('app.purge', 'on', true);

  insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
  values (p_parent_id, p_child_id, 'revoke',
          coalesce((select method from public.consent_ledger where child_id = p_child_id and action = 'grant' order by created_at limit 1), 'other_vpc'),
          coalesce((select policy_version from public.consent_ledger where child_id = p_child_id and action = 'grant' order by created_at desc limit 1), 'v1'),
          jsonb_build_object('source', 'deletion', 'deleting_actor', p_deleting_actor))
  returning id into v_revoke_id;

  if v_auth_user is not null then
    update public.events
       set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{body}', to_jsonb('[removed: child record deleted]'::text))
     where kind = 'message' and author_actor_id = v_auth_user;
    get diagnostics t_msgs = row_count;
  else t_msgs := 0; end if;

  delete from public.attempts where child_id = p_child_id;                    get diagnostics d_attempts = row_count;
  delete from public.submissions where child_id = p_child_id;                 get diagnostics d_subs = row_count;
  delete from public.teaching_artifacts where child_id = p_child_id;          get diagnostics d_arts = row_count;
  delete from public.grade_proposals where child_id = p_child_id;             get diagnostics d_gprop = row_count;   -- before grade_jobs (FK) + before children (RESTRICT)
  delete from public.grade_jobs where child_id = p_child_id;                  get diagnostics d_gjobs = row_count;
  delete from public.grade_cost_ledger where child_id = p_child_id;           get diagnostics d_gledger = row_count;
  delete from public.uploads where child_id = p_child_id;                     get diagnostics d_uploads = row_count;  -- rows (RESTRICT); OBJECTS purged by the worker
  delete from public.invitations where target_child_id = p_child_id;          get diagnostics d_inv = row_count;
  delete from public.child_skill_mastery where child_id = p_child_id;          get diagnostics d_mastery = row_count;
  delete from public.child_skill_misconception where child_id = p_child_id;    get diagnostics d_misc = row_count;
  delete from public.child_skill_assessment where child_id = p_child_id;       get diagnostics d_assess = row_count;
  delete from public.sessions where child_id = p_child_id;                     get diagnostics d_sessions = row_count;
  delete from public.assignments where child_id = p_child_id;                  get diagnostics d_assign = row_count;
  delete from public.child_session_mints where child_id = p_child_id;          get diagnostics d_mints = row_count;
  delete from public.tutor_grants where child_id = p_child_id;                 get diagnostics d_grants = row_count;
  delete from public.memberships where member_child_id = p_child_id;           get diagnostics d_mem = row_count;
  delete from public.channel_members where member_child_id = p_child_id;       get diagnostics d_chmem = row_count;
  delete from public.derivation_outbox where member_child_id = p_child_id;     get diagnostics d_outbox = row_count;
  delete from public.events where subject_child_id = p_child_id;               get diagnostics d_subjevents = row_count;

  delete from public.children where id = p_child_id;

  if not exists (select 1 from public.children where parent_id = p_parent_id) then
    update public.entitlements set status = 'canceled' where parent_id = p_parent_id and status = 'active';
    if found then v_ent := 'canceled_last_child'; end if;
  end if;

  v_disp := jsonb_build_object(
    'deleted', jsonb_build_object('attempts', d_attempts, 'sessions', d_sessions, 'child_skill_mastery', d_mastery,
      'child_skill_misconception', d_misc, 'child_skill_assessment', d_assess, 'assignments', d_assign,
      'submissions', d_subs, 'teaching_artifacts', d_arts, 'uploads', d_uploads, 'invitations', d_inv,
      'grade_jobs', d_gjobs, 'grade_proposals', d_gprop, 'grade_cost_ledger', d_gledger,
      'child_session_mints', d_mints, 'tutor_grants', d_grants, 'memberships', d_mem, 'channel_members', d_chmem,
      'derivation_outbox', d_outbox, 'subject_events', d_subjevents, 'children', 1),
    'tombstoned', jsonb_build_object('authored_messages', t_msgs),
    'retained', jsonb_build_array('consent_ledger', 'audit_log', 'stripe_events', 'deletion_receipts'),
    'entitlement', v_ent);
  perform pg_advisory_xact_lock(hashtext('deletion_receipts_chain'));
  select receipt_hash into v_prev_hash from public.deletion_receipts order by created_at desc, id desc limit 1;
  v_hash := encode(extensions.digest(convert_to(
      coalesce(v_prev_hash, '') || '|' || p_child_id::text || '|' || p_parent_id::text || '|' ||
      coalesce(v_auth_user::text, '') || '|' || p_deleting_actor::text || '|' || coalesce(v_revoke_id::text, '') || '|' ||
      v_disp::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.deletion_receipts (child_id, parent_id, child_auth_user_id, deleting_actor, revoke_consent_id, disposition, prev_receipt_hash, receipt_hash, status)
  values (p_child_id, p_parent_id, v_auth_user, p_deleting_actor, v_revoke_id, v_disp, v_prev_hash, v_hash, 'pending_auth_cleanup')
  returning * into v_receipt;

  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (p_deleting_actor, 'child.delete', p_child_id, 'allow',
          jsonb_build_object('source', 'deletion', 'receipt_id', v_receipt.id, 'child_auth_user_id', v_auth_user, 'disposition', v_disp));

  return jsonb_build_object('ok', true, 'receipt_id', v_receipt.id, 'child_auth_user_id', v_auth_user,
    'status', 'pending_auth_cleanup', 'disposition', v_disp, 'receipt_hash', v_hash);
end $$;
revoke all on function public.purge_child(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_child(uuid, uuid, uuid) to service_role;
