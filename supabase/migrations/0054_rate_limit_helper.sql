-- ============================================================================
-- 0054_rate_limit_helper.sql — a reusable per-CALLER rate limiter for the non-grade public
-- endpoints (HARD RULE #8). Extracts the inline rpc_rate_limits pattern (0002/0040) into one
-- RPC. Keyed on `bucket : auth.uid()` — the caller can never spoof another user's key, and can
-- never evade a given bucket (the edge function passes a fixed bucket). Fixed rolling window.
-- Forward-only. DEV/local only.
-- ============================================================================
create or replace function public.enforce_rate_limit(p_bucket text, p_max int, p_window_secs int)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_rl public.rpc_rate_limits%rowtype;
  v_now timestamptz := now();
  v_window interval;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if p_bucket is null or p_max is null or p_max < 1 then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  v_window := make_interval(secs => greatest(1, coalesce(p_window_secs, 3600)));
  v_key := left(p_bucket, 40) || ':' || v_uid::text;                       -- CALLER-scoped, non-spoofable
  insert into public.rpc_rate_limits as rl (key) values (v_key) on conflict (key) do update set key = rl.key;
  select * into v_rl from public.rpc_rate_limits where key = v_key for update;   -- serialize concurrent calls
  if v_now - v_rl.window_start > v_window then
    update public.rpc_rate_limits set window_start = v_now, call_count = 0 where key = v_key;
    v_rl.call_count := 0; v_rl.window_start := v_now;
  end if;
  if v_rl.call_count >= p_max then
    return jsonb_build_object('ok', false, 'error', 'rate_limited',
      'retry_after_secs', greatest(0, ceil(extract(epoch from (v_rl.window_start + v_window - v_now)))::int));
  end if;
  update public.rpc_rate_limits set call_count = call_count + 1 where key = v_key;
  return jsonb_build_object('ok', true, 'remaining', p_max - (v_rl.call_count + 1));
end $$;
revoke all on function public.enforce_rate_limit(text, int, int) from public, anon;
grant execute on function public.enforce_rate_limit(text, int, int) to authenticated;
