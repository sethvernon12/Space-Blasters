-- ============================================================================
-- 0005_secure_yard.sql — Milestone: "secure the yard" enforcement kernel.
-- LOCAL ONLY, additive. MUST be security-reviewed (review + reviewer sub-agent,
-- like 0001) BEFORE any DEV/prod apply — it adds the authorize() gate, a
-- whitelist context-pack projection, an append-only audit log, and enforces
-- per-artifact visibility.
--
-- Turns the safety model from "represented" to "enforced":
--   * authorize(action, child) — the REAL fail-closed gate (default DENY):
--     consent + grant-scope + family-isolation as PRECONDITIONS. Missing/pending
--     consent BLOCKS (not log-and-allow).
--   * is_guardian(child) — parent-in-the-loop read rule.
--   * child_context_pack(child) — the ONLY thing an AI sees: a whitelist
--     projection keyed by opaque child_id. The child's name is un-emittable BY
--     OMISSION (never selected).
--   * audit_log + write_audit() — append-only who/what/when(+model/prompt).
--   * visibility_scope enum — per-artifact scope, DEFAULT PRIVATE, enforced in
--     RLS (column/enum only; no surfaces).
-- ============================================================================

-- ---- parent-in-the-loop: a guardian may read anything about their child ----
create or replace function public.is_guardian(c uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (select 1 from public.children ch where ch.id = c and ch.parent_id = auth.uid())
$$;

-- ---- authorize(): the fail-closed gate. default DENY. ----
-- Preconditions, in order: authenticated -> consent present -> scope. Family
-- isolation is implicit (the scope predicates key on auth.uid()). SECURITY
-- DEFINER so it can read children.consent_id regardless of RLS, then re-checks
-- scope in code via can_view_child / can_write_child (which read auth.uid()).
create or replace function public.authorize(p_action text, p_child_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_child  public.children%rowtype;
  v_write  boolean := p_action ~ '(write|create|update|delete|grade|assign)';
  v_scoped boolean;
begin
  if v_uid is null then
    return jsonb_build_object('allow', false, 'reason', 'unauthenticated', 'action', p_action);
  end if;
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    return jsonb_build_object('allow', false, 'reason', 'not_authorized', 'action', p_action);  -- no existence oracle
  end if;
  -- CONSENT is a PRECONDITION: missing/pending consent BLOCKS, even the parent.
  if v_child.consent_id is null then
    return jsonb_build_object('allow', false, 'reason', 'no_consent', 'action', p_action);
  end if;
  v_scoped := case when v_write then public.can_write_child(p_child_id) else public.can_view_child(p_child_id) end;
  if not v_scoped then
    return jsonb_build_object('allow', false, 'reason', 'not_authorized', 'action', p_action);
  end if;
  return jsonb_build_object('allow', true, 'reason', 'ok', 'action', p_action,
                            'actor', v_uid, 'child_id', p_child_id, 'access', case when v_write then 'write' else 'read' end);
end $$;
revoke all on function public.authorize(text, uuid) from public, anon;
grant execute on function public.authorize(text, uuid) to authenticated;

-- ---- child_context_pack(): the ONLY projection an AI ever sees ----
-- Whitelist: opaque child_id + per-skill mastery numbers. It NEVER selects
-- nickname / parent_id / emails — identity is un-emittable by omission. Calls
-- authorize() first (fail-closed).
create or replace function public.child_context_pack(p_child_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := public.authorize('child.summary.read', p_child_id);
begin
  if not (v_auth->>'allow')::boolean then
    return jsonb_build_object('denied', true, 'reason', v_auth->>'reason');
  end if;
  return jsonb_build_object(
    'child_id', p_child_id,                 -- opaque; no name anywhere
    'subject', 'math',
    'model_version', 'mastery-v1',
    'generated_at', now(),
    'skills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'skill_id', m.skill_id,
               'display_name', s.display_name,
               'subject', s.subject,
               'attempts', m.attempts_count,
               'correct', m.correct_count,
               'mastery', round((m.alpha / (m.alpha + m.beta))::numeric, 4)
             ) order by s.position)
      from public.child_skill_mastery m
      join public.skills s on s.id = m.skill_id
      where m.child_id = p_child_id), '[]'::jsonb)
  );
end $$;
revoke all on function public.child_context_pack(uuid) from public, anon;
grant execute on function public.child_context_pack(uuid) to authenticated;

-- ---- audit_log: append-only who/what/when for every privileged action ----
create table public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid not null,
  action     text not null,
  child_id   uuid references public.children(id) on delete cascade,
  decision   text not null check (decision in ('allow','deny')),
  detail     jsonb not null default '{}'::jsonb,   -- provider/model/prompt_version/moderation; NO child PII
  created_at timestamptz not null default now()
);
create index audit_log_child_idx on public.audit_log (child_id, created_at);
create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function public.forbid_mutation();
alter table public.audit_log enable row level security;
-- read: the actor sees their own actions; a guardian/tutor sees their child's log
create policy audit_log_select on public.audit_log
  for select to authenticated using (actor_id = auth.uid() or public.can_view_child(child_id));
revoke all on public.audit_log from public, anon;
grant select on public.audit_log to authenticated;   -- writes: write_audit() only

create or replace function public.write_audit(p_action text, p_child_id uuid, p_decision text, p_detail jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  if p_decision not in ('allow','deny') then raise exception 'bad_decision'; end if;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (auth.uid(), p_action, p_child_id, p_decision, coalesce(p_detail, '{}'::jsonb))  -- actor is auth.uid(): un-spoofable
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.write_audit(text, uuid, text, jsonb) from public, anon;
grant execute on function public.write_audit(text, uuid, text, jsonb) to authenticated;

-- ---- visibility_scope: per-artifact scope, DEFAULT PRIVATE, enforced ----
create type public.visibility_scope as enum ('private','family','followers','sent-to-child','internal-staff');

alter table public.teaching_artifacts drop constraint if exists teaching_artifacts_visibility_check;
alter table public.teaching_artifacts alter column visibility drop default;
alter table public.teaching_artifacts alter column visibility type public.visibility_scope using visibility::public.visibility_scope;
alter table public.teaching_artifacts rename column visibility to visibility_scope;
alter table public.teaching_artifacts alter column visibility_scope set default 'private';

-- Enforce it: a viewer sees an artifact only if it isn't private, OR they
-- authored it, OR they are the child's guardian (parent-in-the-loop).
drop policy if exists teaching_artifacts_select on public.teaching_artifacts;
create policy teaching_artifacts_select on public.teaching_artifacts
  for select to authenticated
  using (
    public.can_view_child(child_id)
    and (visibility_scope <> 'private' or author_id = auth.uid() or public.is_guardian(child_id))
  );
