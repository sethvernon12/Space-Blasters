-- ============================================================================
-- 0025_upload_verify.sql — Phase 4 · U2 support. The trusted-authority attestations
-- the upload Edge fn (upload-work) calls with the SERVICE key: mark exif_stripped
-- true ONLY after the server has re-stripped/re-validated, and an upload rate-limit
-- (HARD RULE #8 abuse/bot protection). LOCAL ONLY, additive. SEC-03 before DEV/prod.
-- Both are service_role-only — no client may forge a "verified" flag or bypass the cap.
-- ============================================================================

-- mark_upload_verified: the ONLY path that sets exif_stripped=true. The upload Edge fn
-- calls it (service key) AFTER server-side stripping, so the flag means "the server
-- guaranteed the strip". No client (authenticated/anon) can call it.
create or replace function public.mark_upload_verified(p_upload_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  update public.uploads set exif_stripped = true where id = p_upload_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mark_upload_verified(uuid) from public, anon, authenticated;
grant execute on function public.mark_upload_verified(uuid) to service_role;

-- check_upload_rate: per-actor upload throttle (fixed 1-hour window, generic cap).
-- Service-only — the Edge fn calls it BEFORE storing an object.
create or replace function public.check_upload_rate(p_actor uuid, p_cap int default 60)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_key text := 'upl:' || p_actor::text; v_now timestamptz := now(); v_rl public.rpc_rate_limits%rowtype;
begin
  if p_actor is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  insert into public.rpc_rate_limits as rl (key) values (v_key)
    on conflict (key) do update set key = rl.key returning * into v_rl;
  select * into v_rl from public.rpc_rate_limits where key = v_key for update;   -- serialize per actor
  if v_now - v_rl.window_start > interval '1 hour' then
    update public.rpc_rate_limits set window_start = v_now, call_count = 0 where key = v_key;
    v_rl.call_count := 0;
  end if;
  if v_rl.call_count >= greatest(1, coalesce(p_cap, 60)) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  update public.rpc_rate_limits set call_count = call_count + 1 where key = v_key;
  return jsonb_build_object('ok', true, 'remaining', greatest(1, coalesce(p_cap, 60)) - v_rl.call_count - 1);
end $$;
revoke all on function public.check_upload_rate(uuid, int) from public, anon, authenticated;
grant execute on function public.check_upload_rate(uuid, int) to service_role;