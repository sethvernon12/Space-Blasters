-- ============================================================================
-- 0013_moderation_and_guards.sql — SEC-08 hardening batch, two KER-5 closures.
-- LOCAL ONLY, additive. MUST be security-reviewed before any DEV/prod apply.
--
--   K1 — post_message runs the child-visible body through moderate_text (it was
--        the one child-facing string that skipped the choke point).
--   K2 — a BEFORE INSERT trigger moderates the child-facing text of any
--        CHILD-VISIBLE teaching_artifact (visibility_scope in family/sent-to-child),
--        so a direct client insert (api.ts createGrade) can't push unmoderated
--        feedback/prompt/body/note to a child. Definer approve_* already moderate;
--        this makes moderation structural on the delivery boundary (KER-5).
-- ============================================================================

-- ---- K1: moderate the message body on the authoritative write path ----
create or replace function public.post_message(p_channel_id uuid, p_context_ref_kind text, p_context_ref_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_group_id uuid; v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if p_context_ref_kind is null or p_context_ref_id is null then return jsonb_build_object('ok', false, 'error', 'context_required'); end if;
  select group_id into v_group_id from public.channels where id = p_channel_id;
  if v_group_id is null then return jsonb_build_object('ok', false, 'error', 'unknown_channel'); end if;
  if not exists (select 1 from public.channel_members cm where cm.channel_id = p_channel_id and cm.active
                 and (cm.member_actor_id = v_uid
                      or exists (select 1 from public.children ch where ch.id = cm.member_child_id and (ch.parent_id = v_uid or ch.auth_user_id = v_uid)))) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;
  insert into public.events (kind, author_actor_id, group_id, context_ref_kind, context_ref_id, payload)
  values ('message', v_uid, v_group_id, p_context_ref_kind, p_context_ref_id,
          jsonb_build_object('body', public.moderate_text(left(coalesce(p_body, ''), 2000))))  -- K1: moderated
  returning id into v_event_id;
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;

-- ---- K2: moderate child-facing text on any CHILD-VISIBLE teaching artifact ----
create or replace function public.moderate_artifact_payload() returns trigger
language plpgsql set search_path = ''
as $$
declare k text;
begin
  -- child-visible scopes are the non-private ones (the child can_view self);
  -- moderate the known child-facing text keys if present as strings.
  if new.visibility_scope in ('family', 'sent-to-child') and new.payload is not null then
    foreach k in array array['feedback', 'prompt', 'body', 'note', 'message', 'text'] loop
      if jsonb_typeof(new.payload -> k) = 'string' then
        new.payload := jsonb_set(new.payload, array[k], to_jsonb(public.moderate_text(new.payload ->> k)));
      end if;
    end loop;
  end if;
  return new;
end $$;

-- teaching_artifacts is append-only (forbid_mutation blocks UPDATE), so INSERT is
-- the only delivery boundary that matters.
drop trigger if exists trg_moderate_artifact on public.teaching_artifacts;
create trigger trg_moderate_artifact before insert on public.teaching_artifacts
  for each row execute function public.moderate_artifact_payload();
