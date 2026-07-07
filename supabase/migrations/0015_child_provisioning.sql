-- ============================================================================
-- 0015_child_provisioning.sql — Phase 3 Slice 2: minted child sessions (SQL side).
-- LOCAL ONLY, additive. Joins the Phase-3 SEC-03 review set before any DEV apply.
--
-- Children are opaque, no-email identities under a parent. They are NEVER self-
-- loginable; the ONLY door is a parent-authorized mint. The GoTrue user-creation
-- + link-exchange live in the create-child / start-child-session Edge Functions
-- (the only holders of the service role); this migration is the SQL authority.
--
-- SEC-03 hardening (mint review):
--   * register_child is SERVICE-ONLY (revoked from authenticated) and binds ONLY
--     a fresh, never-signed-in @child.invalid handle to an ADULT parent — a
--     client can never bind an arbitrary/adult uid (no takeover / no is_child_actor
--     poisoning). Per-parent child cap bounds creation.
--   * authorize_and_record_mint rate-limits EVERY attempt (allow or deny) per
--     caller and records it, so denied probing + audit growth are bounded.
-- ============================================================================

-- rate-limit + audit trail for mint ATTEMPTS (no client access at all).
-- child_id is nullable so denied/probe attempts (non-owned or non-existent child)
-- are recorded and count toward the caller's rate limit.
create table if not exists public.child_session_mints (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid not null,                                    -- the CALLER (attempter)
  child_id   uuid references public.children(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.child_session_mints enable row level security;
alter table public.child_session_mints force row level security;
revoke all on public.child_session_mints from public, anon, authenticated;
create index if not exists child_session_mints_rate_idx on public.child_session_mints (parent_id, created_at);

-- ---- register_child: SERVICE-ONLY bind of a FRESH @child.invalid handle ----
create or replace function public.register_child(p_parent_id uuid, p_auth_user_id uuid, p_nickname text, p_grade_band text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_child_id uuid; v_email text; v_last timestamptz; v_count int;
begin
  if p_parent_id is null or p_auth_user_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  -- the parent-of-record must be an ADULT
  if public.is_child_actor(p_parent_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- the child identity MUST be a fresh, never-signed-in @child.invalid handle —
  -- only create-child (service role) can mint these, so no adult/OAuth uid can be bound.
  select email, last_sign_in_at into v_email, v_last from auth.users where id = p_auth_user_id;
  if v_email is null or v_email not like '%@child.invalid' or v_last is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_child_identity');
  end if;
  if exists (select 1 from public.children where auth_user_id = p_auth_user_id) then
    return jsonb_build_object('ok', false, 'error', 'already_registered'); end if;
  select count(*) into v_count from public.children where parent_id = p_parent_id;
  if v_count >= 20 then return jsonb_build_object('ok', false, 'error', 'too_many_children'); end if;
  insert into public.children (parent_id, auth_user_id, nickname, grade_band)
  values (p_parent_id, p_auth_user_id, left(coalesce(nullif(p_nickname, ''), 'Learner'), 40), nullif(left(coalesce(p_grade_band, ''), 8), ''))
  returning id into v_child_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (p_parent_id, 'child.create', v_child_id, 'allow', jsonb_build_object('source', 'provisioning', 'auth_user_id', p_auth_user_id));
  return jsonb_build_object('ok', true, 'child_id', v_child_id);
end $$;
revoke all on function public.register_child(uuid, uuid, text, text) from public, anon, authenticated; -- SERVICE-ONLY
grant execute on function public.register_child(uuid, uuid, text, text) to service_role;

-- ---- authorize_and_record_mint: rate-limit EVERY attempt, then ownership ----
create or replace function public.authorize_and_record_mint(p_child_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_auth_user uuid; v_exists uuid; v_recent int;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  -- rate-limit ALL attempts per caller FIRST — bounds probing + audit growth
  select count(*) into v_recent from public.child_session_mints
   where parent_id = v_uid and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'child.session.mint', null, 'deny', jsonb_build_object('source', 'provisioning', 'reason', 'rate_limited'));
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  select id into v_exists from public.children where id = p_child_id;
  -- ownership: caller must be THE PARENT of the child (never a tutor or the child)
  select auth_user_id into v_auth_user from public.children where id = p_child_id and parent_id = v_uid;
  -- record the attempt (child_id nullable → non-existent/non-owned probes count too)
  insert into public.child_session_mints (parent_id, child_id) values (v_uid, v_exists);
  if v_auth_user is null then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'child.session.mint', v_exists, 'deny', jsonb_build_object('source', 'provisioning', 'reason', 'not_parent'));
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'child.session.mint', p_child_id, 'allow', jsonb_build_object('source', 'provisioning'));
  return jsonb_build_object('ok', true, 'auth_user_id', v_auth_user);
end $$;
revoke all on function public.authorize_and_record_mint(uuid) from public, anon;
grant execute on function public.authorize_and_record_mint(uuid) to authenticated;
