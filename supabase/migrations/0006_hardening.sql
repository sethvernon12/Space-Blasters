-- ============================================================================
-- 0006_hardening.sql — security-review hardening (RM-06 findings). LOCAL ONLY,
-- additive. MUST be security-reviewed before any DEV/prod apply (SEC-03).
--
-- Closes the findings from the independent red-team review:
--   #1 SEC-02  — pin every SECURITY DEFINER search_path to '' + bake the
--                "no CREATE on public for client roles" guarantee into the schema.
--   #2 LEG-03 / SEC-08(b) — consent-gate EVERY raw child-DATA read policy so
--                reads fail closed on missing/revoked consent (even the parent);
--                the children profile row's PARENT branch stays ungated for
--                onboarding/deletion; consent_ledger/tutor_grants stay readable.
--   #3 SEC-07 / ACC-06 — audit writes are unforgeable: write_audit recomputes
--                decision from a fresh authorize(), caps detail, stamps source.
--   #4 KER-2   — authorize() checks scope FIRST (no consent-state oracle).
--   #5 SAF-02  — FORCE RLS on assignments, teaching_artifacts, audit_log.
--   #6 DM-3/ROLE-5 — assignments UPDATE can't forge assigned_by.
-- ============================================================================

-- ---- #1a: pin DEFINER search_path='' on the bodies we are NOT rewriting ----
-- (all references in these bodies are already schema-qualified: public.* /
--  extensions.crypt / auth.uid(); pg_catalog built-ins remain implicit.)
alter function public.record_attempts(text, text, jsonb)   set search_path = '';
alter function public.record_attempts_authed(uuid, jsonb)   set search_path = '';
alter function public.log_tutor_disclosure()                set search_path = '';
alter function public.child_context_pack(uuid)              set search_path = '';

-- ---- #1b: the CREATE-on-public guarantee travels with the schema ----
revoke create on schema public from public;
revoke create on schema public from anon;
revoke create on schema public from authenticated;

-- ---- #2: has_active_consent — SECURITY DEFINER to avoid children RLS recursion
-- (returns only a boolean; used inside SELECT policies). ----
create or replace function public.has_active_consent(c uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select exists (select 1 from public.children ch where ch.id = c and ch.consent_id is not null) $$;
revoke all on function public.has_active_consent(uuid) from public, anon;
grant execute on function public.has_active_consent(uuid) to authenticated;

-- ---- #4 + #1: authorize() rewritten — SCOPE FIRST (no oracle), search_path='' ----
create or replace function public.authorize(p_action text, p_child_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
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
    return jsonb_build_object('allow', false, 'reason', 'not_authorized', 'action', p_action);
  end if;
  -- SCOPE FIRST: an unscoped caller learns nothing about the child (no consent oracle).
  v_scoped := case when v_write then public.can_write_child(p_child_id) else public.can_view_child(p_child_id) end;
  if not v_scoped then
    return jsonb_build_object('allow', false, 'reason', 'not_authorized', 'action', p_action);
  end if;
  -- Only a scoped actor may learn consent state; missing consent still BLOCKS (even the parent).
  if v_child.consent_id is null then
    return jsonb_build_object('allow', false, 'reason', 'no_consent', 'action', p_action);
  end if;
  return jsonb_build_object('allow', true, 'reason', 'ok', 'action', p_action,
                            'actor', v_uid, 'child_id', p_child_id, 'access', case when v_write then 'write' else 'read' end);
end $$;
revoke all on function public.authorize(text, uuid) from public, anon;
grant execute on function public.authorize(text, uuid) to authenticated;

-- ---- #3 + #1: write_audit rewritten — unforgeable decision, capped detail ----
create or replace function public.write_audit(p_action text, p_child_id uuid, p_decision text, p_detail jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_decision text;
  v_detail  jsonb;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  -- DECISION is RECOMPUTED from a fresh authorize() — the client-supplied
  -- p_decision is ignored, so a caller can never fabricate an 'allow'.
  v_decision := case when (public.authorize(p_action, p_child_id)->>'allow')::boolean then 'allow' else 'deny' end;
  v_detail := coalesce(p_detail, '{}'::jsonb);
  if pg_column_size(v_detail) > 2048 then v_detail := jsonb_build_object('truncated', true); end if;
  v_detail := v_detail || jsonb_build_object('source', 'kernel');   -- definer-set; client cannot control
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (auth.uid(), p_action, p_child_id, v_decision, v_detail)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.write_audit(text, uuid, text, jsonb) from public, anon;
grant execute on function public.write_audit(text, uuid, text, jsonb) to authenticated;

-- ---- #2: consent-gate every child-DATA read policy (fail-closed reads) ----
drop policy if exists attempts_select on public.attempts;
create policy attempts_select on public.attempts for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));

drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));

drop policy if exists mastery_select on public.child_skill_mastery;
create policy mastery_select on public.child_skill_mastery for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));

drop policy if exists misconception_select on public.child_skill_misconception;
create policy misconception_select on public.child_skill_misconception for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));

drop policy if exists assignments_select on public.assignments;
create policy assignments_select on public.assignments for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));

-- teaching_artifacts: keep the visibility_scope enforcement, add consent gate
drop policy if exists teaching_artifacts_select on public.teaching_artifacts;
create policy teaching_artifacts_select on public.teaching_artifacts for select to authenticated
  using (
    public.can_view_child(child_id) and public.has_active_consent(child_id)
    and (visibility_scope <> 'private' or author_id = auth.uid() or public.is_guardian(child_id))
  );

-- audit_log: self-view (actor's own actions) stays ungated; the child-view branch is consent-gated
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (actor_id = auth.uid() or (public.can_view_child(child_id) and public.has_active_consent(child_id)));

-- children profile: PARENT branch ungated (needed to drive consent + deletion);
-- the child-self and tutor branches are consent-gated.
drop policy if exists children_select on public.children;
create policy children_select on public.children for select to authenticated
  using (
    parent_id = auth.uid()
    or (public.has_active_consent(children.id) and (
          auth_user_id = auth.uid()
          or exists (select 1 from public.tutor_grants tg
                      where tg.child_id = children.id and tg.tutor_id = auth.uid() and tg.active)
       ))
  );

-- ---- #5: FORCE RLS (definer writers run as a BYPASSRLS role — unaffected) ----
alter table public.assignments        force row level security;
alter table public.teaching_artifacts force row level security;
alter table public.audit_log          force row level security;

-- ---- #6: assignments UPDATE can't forge assigned_by / re-parent authorship ----
drop policy if exists assignments_update on public.assignments;
create policy assignments_update on public.assignments for update to authenticated
  using (public.can_write_child(child_id))
  with check (public.can_write_child(child_id) and assigned_by = auth.uid());
