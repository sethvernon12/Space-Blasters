-- ============================================================================
-- 0010_assignment_gen.sql — RM-08b generateAssignment (AI-3d) on the same
-- proposal-behind-approval kernel path as grades. LOCAL ONLY, additive. MUST be
-- security-reviewed before any DEV/prod apply (SEC-03).
--
-- SQL picks the skill + difficulty (~85% target); the model only renders wording
-- (via the gateway); the deterministic solver validates every item at generation
-- AND again at approval (before a child can ever see it); nothing reaches the
-- child without human approval. The AI proposal is a PRIVATE artifact; approval
-- delivers an `assignments` row (child-visible) with an answer-free item set.
-- ============================================================================

-- proposals reuse teaching_artifacts (private, author 'ai'); add the kind
alter table public.teaching_artifacts drop constraint if exists teaching_artifacts_kind_check;
alter table public.teaching_artifacts add constraint teaching_artifacts_kind_check
  check (kind in ('grade','annotation','feedback','reteach','material','assignment'));

-- delivered assignments carry their (answer-free) items
alter table public.assignments add column if not exists items jsonb;

-- ---- pick_assignment_plan: SQL picks skill + difficulty (~85% target) ----
-- Deterministic — the model never picks the math or the answer. Focus = the
-- skill whose mastery is nearest the 0.85 target; items carry solver answers.
create or replace function public.pick_assignment_plan(p_child_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_skill text; v_display text; v_cat text; v_p numeric; v_items jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('denied', true, 'reason', 'unauthenticated'); end if;
  if not public.can_write_child(p_child_id) then return jsonb_build_object('denied', true, 'reason', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = p_child_id and consent_id is not null) then
    return jsonb_build_object('denied', true, 'reason', 'no_consent'); end if;

  select m.skill_id, round((m.alpha / (m.alpha + m.beta))::numeric, 4)
    into v_skill, v_p
  from public.child_skill_mastery m
  where m.child_id = p_child_id
  order by abs((m.alpha / (m.alpha + m.beta)) - 0.85)   -- nearest the ~85% productive zone
  limit 1;
  if v_skill is null then v_skill := 'add5'; v_p := 0.5; end if;
  select display_name, category into v_display, v_cat from public.skills where id = v_skill;

  v_items := case v_cat
    when 'subtraction' then jsonb_build_array(
      jsonb_build_object('operator','-','operands',jsonb_build_array(5,2),'correct_answer',3),
      jsonb_build_object('operator','-','operands',jsonb_build_array(4,1),'correct_answer',3),
      jsonb_build_object('operator','-','operands',jsonb_build_array(5,3),'correct_answer',2),
      jsonb_build_object('operator','-','operands',jsonb_build_array(3,1),'correct_answer',2))
    else jsonb_build_array(   -- addition (default focus)
      jsonb_build_object('operator','+','operands',jsonb_build_array(2,3),'correct_answer',5),
      jsonb_build_object('operator','+','operands',jsonb_build_array(1,4),'correct_answer',5),
      jsonb_build_object('operator','+','operands',jsonb_build_array(2,2),'correct_answer',4),
      jsonb_build_object('operator','+','operands',jsonb_build_array(4,1),'correct_answer',5))
  end;
  return jsonb_build_object('skill_id', v_skill, 'skill_display', v_display, 'category', v_cat,
                           'difficulty', 'on-level', 'predicted_p', v_p, 'items', v_items);
end $$;
revoke all on function public.pick_assignment_plan(uuid) from public, anon;
grant execute on function public.pick_assignment_plan(uuid) to authenticated;

-- ---- propose_assignment: SERVICE-PATH writer for the AI proposal (private) ----
create or replace function public.propose_assignment(p_child_id uuid, p_skill_id text, p_difficulty text, p_predicted_p numeric, p_items jsonb, p_title text, p_model text, p_prompt_version text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if not public.can_write_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = p_child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, visibility_scope)
  values (p_child_id, null, 'ai', 'assignment', 'math',
          jsonb_build_object('skill_id', p_skill_id, 'difficulty', p_difficulty, 'predicted_p', p_predicted_p,
                             'items', p_items, 'title', p_title, 'model', p_model, 'prompt_version', p_prompt_version, 'proposed', true),
          'private')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'proposal_id', v_id);
end $$;
revoke all on function public.propose_assignment(uuid, text, text, numeric, jsonb, text, text, text) from public, anon;
grant execute on function public.propose_assignment(uuid, text, text, numeric, jsonb, text, text, text) to authenticated;

-- ---- pending_assignments: the approvals queue ----
create or replace function public.pending_assignments() returns setof public.teaching_artifacts
language sql stable security definer set search_path = ''
as $$
  select a.* from public.teaching_artifacts a
  where a.kind = 'assignment' and a.author_role = 'ai'
    and public.can_write_child(a.child_id)
    and not exists (select 1 from public.teaching_artifacts s where s.supersedes_id = a.id)
$$;
revoke all on function public.pending_assignments() from public, anon;
grant execute on function public.pending_assignments() to authenticated;

-- ---- approve_assignment: the ONLY delivery path (re-validates every item) ----
create or replace function public.approve_assignment(p_proposal_id uuid, p_override_title text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_art public.teaching_artifacts%rowtype;
  v_items jsonb; v_delivered jsonb; v_it jsonb; v_expected int; v_assignment_id uuid;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_art from public.teaching_artifacts where id = p_proposal_id and kind = 'assignment' and author_role = 'ai';
  if v_art.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_proposal'); end if;
  if not public.can_write_child(v_art.child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = v_art.child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;

  v_items := coalesce(v_art.payload->'items', '[]'::jsonb);
  -- SOLVER re-validates EVERY item before delivery (AI-3d) and strips the answer key
  v_delivered := '[]'::jsonb;
  for v_it in select * from jsonb_array_elements(v_items) loop
    v_expected := case v_it->>'operator'
      when '+' then (v_it->'operands'->>0)::int + (v_it->'operands'->>1)::int
      when '-' then (v_it->'operands'->>0)::int - (v_it->'operands'->>1)::int
      when '*' then (v_it->'operands'->>0)::int * (v_it->'operands'->>1)::int
      else null end;
    if v_expected is null or (v_it->>'correct_answer')::int <> v_expected then
      return jsonb_build_object('ok', false, 'error', 'invalid_items');   -- never deliver an unvalidated item
    end if;
    -- child-visible item: operator + operands + prompt ONLY (answer stays server-side, recomputed at grade time)
    v_delivered := v_delivered || jsonb_build_array(jsonb_build_object(
      'operator', v_it->>'operator', 'operands', v_it->'operands', 'prompt', coalesce(v_it->>'prompt', '')));
  end loop;

  insert into public.assignments (child_id, assigned_by, skill_id, title, status, items)
  values (v_art.child_id, auth.uid(), v_art.payload->>'skill_id',
          left(coalesce(p_override_title, v_art.payload->>'title', 'Practice'), 120), 'assigned', v_delivered)
  returning id into v_assignment_id;

  insert into public.teaching_artifacts (child_id, author_id, author_role, kind, subject, payload, supersedes_id, visibility_scope)
  values (v_art.child_id, auth.uid(), case when public.is_my_child(v_art.child_id) then 'parent' else 'tutor' end,
          'assignment', 'math', jsonb_build_object('delivered_assignment_id', v_assignment_id), p_proposal_id, 'private');

  perform public.write_audit('ai.assignment.approve', v_art.child_id, 'allow',
    jsonb_build_object('proposal_id', p_proposal_id, 'assignment_id', v_assignment_id,
                       'model', v_art.payload->>'model', 'prompt_version', v_art.payload->>'prompt_version'));
  return jsonb_build_object('ok', true, 'assignment_id', v_assignment_id, 'items', jsonb_array_length(v_delivered));
end $$;
revoke all on function public.approve_assignment(uuid, text) from public, anon;
grant execute on function public.approve_assignment(uuid, text) to authenticated;
