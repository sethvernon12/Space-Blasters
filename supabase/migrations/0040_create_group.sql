-- 0040_create_group.sql — Phase 5 · Group Engine · S2. create_group(purpose, name, season):
-- the RPC that stands up a leader-led standalone group (a class led by a tutor, a team led by
-- a coach). Mirrors create_homeschool_family's hygiene: SECURITY DEFINER, search_path='',
-- authenticated-only, child-actor blocked, and the ZOMBIE-WRITE guard (a deleted/held actor —
-- a captured pre-purge token whose children row is gone but whose deletion receipt exists —
-- cannot create a group; mirrors the groups_insert policy 0018:177-178, which this definer
-- bypasses so it must re-check here). No bespoke write: the creator's LEADER membership is
-- written through join_group, i.e. the SAME atomic membership + Event + idempotent outbox path
-- every membership uses, so a leader join derives + audits like any other. family is created via
-- create_homeschool_family and academy is pre-created out-of-band, so both are refused here.
-- Forward-only. DEV/local only.
create or replace function public.create_group(p_purpose text, p_name text, p_season text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_gid uuid; v_role text; v_name text;
        v_key text; v_rl public.rpc_rate_limits%rowtype; v_now timestamptz := now();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if; -- never a child login
  if public.actor_is_deleted(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if; -- zombie-write guard
  -- leader role by purpose (role×purpose): a class leader is a tutor, a team leader is a coach.
  v_role := case p_purpose when 'class' then 'tutor' when 'team' then 'coach' else null end;
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'bad_purpose'); end if; -- family/academy/follower_circle not via this RPC
  v_name := left(btrim(coalesce(p_name, '')), 120);
  if v_name = '' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;

  -- per-actor throttle (HARD RULE #8; mirrors check_upload_rate) — bound group-creation spam,
  -- fixed 1-hour window, a SEPARATE 'grp:' counter so it never shares the upload budget.
  v_key := 'grp:' || v_uid::text;
  insert into public.rpc_rate_limits as rl (key) values (v_key) on conflict (key) do update set key = rl.key;
  select * into v_rl from public.rpc_rate_limits where key = v_key for update;
  if v_now - v_rl.window_start > interval '1 hour' then
    update public.rpc_rate_limits set window_start = v_now, call_count = 0 where key = v_key;
    v_rl.call_count := 0;
  end if;
  if v_rl.call_count >= 30 then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;
  update public.rpc_rate_limits set call_count = call_count + 1 where key = v_key;

  insert into public.groups (purpose, name, season, created_by)
    values (p_purpose::public.group_purpose, v_name, nullif(left(btrim(coalesce(p_season, '')), 120), ''), v_uid)
    returning id into v_gid;
  -- the creator's LEADER membership through the transactional outbox path (no bespoke write).
  -- join_group authorizes on created_by = auth.uid() (the group just created by this caller).
  perform public.join_group(v_gid, null, v_uid, v_role);
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'group.create', null, 'allow', jsonb_build_object('group_id', v_gid, 'purpose', p_purpose, 'role', v_role));
  return jsonb_build_object('ok', true, 'group_id', v_gid, 'role', v_role);
end $$;
revoke all on function public.create_group(text, text, text) from public, anon;
grant execute on function public.create_group(text, text, text) to authenticated;
