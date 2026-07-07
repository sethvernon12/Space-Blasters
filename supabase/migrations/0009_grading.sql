-- ============================================================================
-- 0009_grading.sql — RM-08 the AI teacher's-assistant GRADING loop (AI-3/AI-4,
-- KER-7, ACC-05). LOCAL ONLY, additive. MUST be security-reviewed before any
-- DEV/prod apply (SEC-03).
--
-- Loop: a child turns in graded work (submissions, immutable raw work) -> the
-- AI pre-grades via the gateway and writes a PRIVATE proposal artifact (never
-- authoritative) -> a human APPROVES/OVERRIDES, which writes an append-only
-- `grade` Event (verdict = the deterministic SOLVER's, always; override changes
-- only feedback) + a moderated child-visible feedback Artifact + deepens a
-- SEPARATE child_skill_assessment projection. The Beta mastery spine (attempts)
-- is untouched by this path; the AI never writes mastery/consent/projection.
-- ============================================================================

alter type public.event_kind add value if not exists 'submission';
alter type public.event_kind add value if not exists 'grade';

-- ---- submissions: the child's turned-in graded work (immutable raw work) ----
create table public.submissions (
  id                   uuid primary key default gen_random_uuid(),
  child_id             uuid not null references public.children(id) on delete cascade,
  skill_id             text not null references public.skills(id),
  assignment_id        uuid references public.assignments(id),
  client_submission_id uuid not null,                 -- idempotency
  problem_dna          jsonb not null default '{}'::jsonb,  -- {operator, operands, prompt, correct_answer}
  submitted_answer     int,
  explanation          text,                          -- child's words — UNTRUSTED at the gateway
  created_at           timestamptz not null default now(),
  unique (child_id, client_submission_id)
);
create index submissions_child_idx on public.submissions (child_id, created_at);
create trigger submissions_immutable
  before update or delete on public.submissions for each row execute function public.forbid_mutation();  -- SAF-08
alter table public.submissions enable row level security; alter table public.submissions force row level security;
create policy submissions_select on public.submissions for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));
revoke all on public.submissions from public, anon;
grant select on public.submissions to authenticated;   -- write via record_submission RPC only

-- ---- child_skill_assessment: a SEPARATE projection deepened by recorded grades
-- (never the Beta mastery; AI never writes it; recomputable by replay — DATA-3/4)
create table public.child_skill_assessment (
  child_id               uuid not null references public.children(id) on delete cascade,
  skill_id               text not null references public.skills(id),
  graded_count           int not null default 0,
  correct_count          int not null default 0,
  transfer_success_count int not null default 0,   -- graded work = transfer/understanding evidence
  last_graded_at         timestamptz,
  model_version          text not null default 'assess-v1',
  updated_at             timestamptz not null default now(),
  primary key (child_id, skill_id)
);
alter table public.child_skill_assessment enable row level security; alter table public.child_skill_assessment force row level security;
create policy assessment_select on public.child_skill_assessment for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));
revoke all on public.child_skill_assessment from public, anon;
grant select on public.child_skill_assessment to authenticated;   -- writes: approve_grade / rebuild_assessment only

-- ---- moderate_text: in-DB choke point for any child-facing string (KER-5) ----
create or replace function public.moderate_text(t text) returns text
language sql immutable
as $$
  select case when t ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|[0-9]{3}[-.[:space:]][0-9]{3}[-.[:space:]][0-9]{4})'
              then 'Nice effort — see your teacher''s notes.' else coalesce(t, '') end
$$;

-- ---- record_submission: the child turns in work (is_my_child, consent, idempotent)
create or replace function public.record_submission(p_child_id uuid, p_skill_id text, p_client_submission_id uuid, p_problem_dna jsonb, p_submitted_answer int, p_explanation text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if not public.is_my_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = p_child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  insert into public.submissions (child_id, skill_id, client_submission_id, problem_dna, submitted_answer, explanation)
  values (p_child_id, p_skill_id, p_client_submission_id, coalesce(p_problem_dna, '{}'::jsonb), p_submitted_answer, left(p_explanation, 2000))
  on conflict (child_id, client_submission_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.submissions where child_id = p_child_id and client_submission_id = p_client_submission_id;
    return jsonb_build_object('ok', true, 'submission_id', v_id, 'duplicate', true);
  end if;
  return jsonb_build_object('ok', true, 'submission_id', v_id);
end $$;
revoke all on function public.record_submission(uuid, text, uuid, jsonb, int, text) from public, anon;
grant execute on function public.record_submission(uuid, text, uuid, jsonb, int, text) to authenticated;

-- ---- propose_grade: SERVICE-PATH writer for the AI proposal (private, NOT authoritative)
create or replace function public.propose_grade(p_submission_id uuid, p_verdict text, p_score int, p_feedback text, p_model text, p_prompt_version text, p_misconception_id text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_sub public.submissions%rowtype; v_id uuid;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_sub from public.submissions where id = p_submission_id;
  if v_sub.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_submission'); end if;
  if not public.can_write_child(v_sub.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_sub.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, target_kind, target_id, visibility_scope)
  values (v_sub.child_id, null, 'ai', 'grade', 'math',
          jsonb_build_object('verdict', p_verdict, 'score', p_score, 'feedback', p_feedback,
                             'model', p_model, 'prompt_version', p_prompt_version,
                             'misconception_id', p_misconception_id, 'proposed', true),
          'submission', p_submission_id, 'private')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'proposal_id', v_id);
end $$;
revoke all on function public.propose_grade(uuid, text, int, text, text, text, text) from public, anon;
grant execute on function public.propose_grade(uuid, text, int, text, text, text, text) to authenticated;

-- ---- pending_grades: the approvals queue (AI proposals not yet approved) ----
create or replace function public.pending_grades() returns setof public.teaching_artifacts
language sql stable security definer set search_path = ''
as $$
  select a.* from public.teaching_artifacts a
  where a.kind = 'grade' and a.author_role = 'ai'
    and public.can_write_child(a.child_id)
    and not exists (select 1 from public.teaching_artifacts s where s.supersedes_id = a.id)
$$;
revoke all on function public.pending_grades() from public, anon;
grant execute on function public.pending_grades() to authenticated;

-- ---- approve_grade: the ONLY path that RECORDS a grade (human approval) ----
-- Verdict = deterministic SOLVER (AI-4), always; override changes only feedback.
create or replace function public.approve_grade(p_proposal_id uuid, p_override_feedback text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_art public.teaching_artifacts%rowtype;
  v_sub public.submissions%rowtype;
  v_correct boolean; v_verdict text; v_feedback text; v_event_id uuid; v_overridden boolean;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_art from public.teaching_artifacts where id = p_proposal_id and kind = 'grade' and author_role = 'ai';
  if v_art.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_art.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_art.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  select * into v_sub from public.submissions where id = v_art.target_id;
  if v_sub.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_submission'); end if;

  -- THE ARBITER (AI-4): recompute correctness deterministically; ignore AI/human verdict
  v_correct := (v_sub.submitted_answer is not distinct from (v_sub.problem_dna->>'correct_answer')::int);
  v_verdict := case when v_correct then 'correct' else 'incorrect' end;
  v_overridden := p_override_feedback is not null;
  v_feedback := public.moderate_text(coalesce(p_override_feedback, v_art.payload->>'feedback', ''));

  -- authoritative, append-only grade EVENT — written ONLY here, on human approval
  insert into public.events (kind, author_actor_id, subject_child_id, context_ref_kind, context_ref_id, payload)
  values ('grade', auth.uid(), v_art.child_id, 'submission', v_sub.id,
          jsonb_build_object('verdict', v_verdict, 'score', case when v_correct then 100 else 0 end,
                             'submission_id', v_sub.id, 'skill_id', v_sub.skill_id, 'ai_proposal_id', p_proposal_id,
                             'overridden', v_overridden, 'model', v_art.payload->>'model', 'prompt_version', v_art.payload->>'prompt_version'))
  returning id into v_event_id;

  -- child-visible feedback Artifact (moderated), superseding the AI proposal
  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, target_kind, target_id, supersedes_id, visibility_scope)
  values (v_art.child_id, auth.uid(),
          case when public.is_my_child(v_art.child_id) then 'parent' else 'tutor' end,
          'feedback', 'math', jsonb_build_object('feedback', v_feedback, 'grade_event_id', v_event_id),
          'submission', v_sub.id, p_proposal_id, 'sent-to-child');

  -- deepen the SEPARATE per-child assessment projection (never the Beta mastery)
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
revoke all on function public.approve_grade(uuid, text) from public, anon;
grant execute on function public.approve_grade(uuid, text) to authenticated;

-- ---- rebuild_assessment: deterministic replay from grade Events (DATA-4 reconciler)
create or replace function public.rebuild_assessment(p_child_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if not public.can_view_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
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
revoke all on function public.rebuild_assessment(uuid) from public, anon;
grant execute on function public.rebuild_assessment(uuid) to authenticated;
