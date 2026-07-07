-- ============================================================================
-- 0015_child_provisioning.sql — Phase 3 Slice 2: minted child sessions (SQL side).
-- LOCAL ONLY, additive. Joins the Phase-3 SEC-03 review set before any DEV apply.
--
-- Children are opaque, no-email identities under a parent. They are NEVER self-
-- loginable; the ONLY door is a parent-authorized mint. The GoTrue user-creation
-- + link-exchange live in the create-child / start-child-session Edge Functions
-- (the only holders of the service role); this migration is the SQL authority:
--   * register_child           — bind a pre-created GoTrue user under the caller
--                                (adult only), audited.
--   * authorize_and_record_mint — ownership (caller = the child's PARENT) +
--                                rate-limit + audit, keyed to auth.uid(); returns
--                                the child's auth_user_id ONLY to the owning parent.
-- The Edge Function calls authorize_and_record_mint BEFORE any service-role use,
-- so a non-parent / over-limit caller gets nothing to mint against.
-- ============================================================================

-- rate-limit + audit trail for minted child sessions (no client access at all)
create table if not exists public.child_session_mints (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid not null,
  child_id   uuid not null references public.children(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.child_session_mints enable row level security;
alter table public.child_session_mints force row level security;
revoke all on public.child_session_mints from public, anon, authenticated;
create index if not exists child_session_mints_rate_idx on public.child_session_mints (parent_id, created_at);

-- ---- register_child: adult-only bind of a GoTrue user to a child profile ----
create or replace function public.register_child(p_auth_user_id uuid, p_nickname text, p_grade_band text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_child_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if; -- adults only
  if p_auth_user_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  if exists (select 1 from public.children where auth_user_id = p_auth_user_id) then
    return jsonb_build_object('ok', false, 'error', 'already_registered'); end if;
  insert into public.children (parent_id, auth_user_id, nickname, grade_band)
  values (v_uid, p_auth_user_id, left(coalesce(nullif(p_nickname, ''), 'Learner'), 40), nullif(left(coalesce(p_grade_band, ''), 8), ''))
  returning id into v_child_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'child.create', v_child_id, 'allow', jsonb_build_object('source', 'provisioning', 'auth_user_id', p_auth_user_id));
  return jsonb_build_object('ok', true, 'child_id', v_child_id);
end $$;
revoke all on function public.register_child(uuid, text, text) from public, anon;
grant execute on function public.register_child(uuid, text, text) to authenticated;

-- ---- authorize_and_record_mint: ownership + rate-limit + audit ----
create or replace function public.authorize_and_record_mint(p_child_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_auth_user uuid; v_exists uuid; v_recent int;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select id into v_exists from public.children where id = p_child_id;
  -- ownership: caller must be THE PARENT of the child (never a tutor or the child)
  select auth_user_id into v_auth_user from public.children where id = p_child_id and parent_id = v_uid;
  if v_auth_user is null then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'child.session.mint', v_exists, 'deny', jsonb_build_object('source', 'provisioning', 'reason', 'not_parent'));
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  -- rate limit: at most 10 mints per parent per rolling 60s
  select count(*) into v_recent from public.child_session_mints
   where parent_id = v_uid and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'child.session.mint', p_child_id, 'deny', jsonb_build_object('source', 'provisioning', 'reason', 'rate_limited'));
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  insert into public.child_session_mints (parent_id, child_id) values (v_uid, p_child_id);
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'child.session.mint', p_child_id, 'allow', jsonb_build_object('source', 'provisioning'));
  return jsonb_build_object('ok', true, 'auth_user_id', v_auth_user);
end $$;
revoke all on function public.authorize_and_record_mint(uuid) from public, anon;
grant execute on function public.authorize_and_record_mint(uuid) to authenticated;
