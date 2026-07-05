-- ============================================================================
-- 0002_attempt_context.sql — Milestone 1: the `context` jsonb escape hatch.
-- ============================================================================
-- STATUS: NOT APPLIED to DEV or PROD. Additive, reversible, LOCAL-verified only.
-- This migration AND the record_attempts change below MUST be re-reviewed
-- (security review + reviewer sub-agent, as 0001 was) BEFORE it ever reaches a
-- hosted database. It touches the SECURITY DEFINER write path.
--
-- What it does, minimally and additively:
--   1. adds a nullable-by-default `context jsonb not null default '{}'` column
--      to public.attempts — a forward-compatible escape hatch so new capture
--      signals can be recorded WITHOUT another migration (they land in
--      context->>'...' until/unless promoted to a typed column).
--   2. re-creates record_attempts (create or replace) IDENTICAL to 0001 except
--      it now persists a client-provided `context` object per attempt
--      (coalesced to '{}'). Everything else — auth, consent gate, rate limits,
--      idempotency, per-element skill validation, mastery mirror, counts-only
--      return — is byte-for-byte the reviewed 0001 behavior.
-- ============================================================================

alter table public.attempts
  add column if not exists context jsonb not null default '{}'::jsonb;

comment on column public.attempts.context is
  'Forward-compat escape hatch: extra capture signals recorded without a migration. No PII.';

-- ---- record_attempts (unchanged from 0001 except the two `context` lines) ----
create or replace function public.record_attempts(p_name text, p_pin text, p_batch jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_key         text := 'rec:' || lower(trim(coalesce(p_name,'')));
  v_now         timestamptz := now();
  v_rl          public.rpc_rate_limits%rowtype;
  v_player      public.players%rowtype;
  v_child       public.children%rowtype;
  v_session_id  uuid;
  v_el          jsonb;
  v_skill       public.skills%rowtype;
  v_result      text;
  v_attempt_id  uuid;
  v_inserted_id uuid;
  v_n_batch     int;
  v_inserted    int := 0;
  v_duplicates  int := 0;
  v_rejected    int := 0;
  v_counted     boolean;
  v_correct     boolean;
  v_m           public.child_skill_mastery%rowtype;
  v_w           numeric;
  v_gap_days    numeric;
begin
  -- ---- shape checks (cheap, before any lookup) ----
  if p_name is null or p_pin is null or p_batch is null
     or p_pin !~ '^[0-9]{4}$'
     or jsonb_typeof(p_batch->'attempts') <> 'array' then
    return json_build_object('ok', false, 'error', 'bad_request');
  end if;
  v_n_batch := jsonb_array_length(p_batch->'attempts');
  if v_n_batch > 200 then
    return json_build_object('ok', false, 'error', 'batch_too_large');
  end if;

  -- ---- rate limiting (locked row per name; serializes concurrent calls) ----
  delete from public.rpc_rate_limits
   where window_start < v_now - interval '7 days'
     and (locked_until is null or locked_until < v_now);
  insert into public.rpc_rate_limits as rl (key) values (v_key)
    on conflict (key) do update set key = rl.key
    returning * into v_rl;
  select * into v_rl from public.rpc_rate_limits where key = v_key for update;
  if v_rl.locked_until is not null and v_rl.locked_until > v_now then
    return json_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if v_now - v_rl.window_start > interval '1 minute' then
    update public.rpc_rate_limits
       set window_start = v_now, call_count = 0, attempt_count = 0
     where key = v_key;
    v_rl.call_count := 0; v_rl.attempt_count := 0;
  end if;
  if v_rl.call_count >= 6 or v_rl.attempt_count + v_n_batch > 300 then
    return json_build_object('ok', false, 'error', 'rate_limited');
  end if;
  update public.rpc_rate_limits
     set call_count = call_count + 1, attempt_count = attempt_count + v_n_batch
   where key = v_key;

  -- ---- authenticate: name + PIN verified server-side ----
  select * into v_player from public.players where lower(name) = lower(trim(p_name));
  if v_player.id is null or not public.verify_pin(p_pin, v_player.pin_hash) then
    update public.rpc_rate_limits
       set bad_pin_count = bad_pin_count + 1,
           locked_until = case when bad_pin_count + 1 >= 5
                               then v_now + interval '15 minutes' end
     where key = v_key;
    return json_build_object('ok', false, 'error', 'denied');
  end if;
  update public.rpc_rate_limits set bad_pin_count = 0 where key = v_key;

  -- ---- resolve the child SERVER-SIDE; enforce the consent gate ----
  select * into v_child from public.children where legacy_player_id = v_player.id;
  if v_child.id is null then
    return json_build_object('ok', false, 'error', 'no_profile');
  end if;
  if v_child.consent_id is null then
    return json_build_object('ok', false, 'error', 'no_consent');
  end if;

  -- ---- session upsert ----
  begin
    insert into public.sessions as s (child_id, client_session_id, module_id, mode, started_at, ended_at)
    values (
      v_child.id,
      (p_batch->>'client_session_id')::uuid,
      coalesce(p_batch->>'module_id', 'space-blasters'),
      p_batch->>'mode',
      coalesce((p_batch->>'started_at')::timestamptz, v_now),
      (p_batch->>'ended_at')::timestamptz
    )
    on conflict (child_id, client_session_id) do update
      set ended_at = coalesce(excluded.ended_at, s.ended_at),
          mode     = coalesce(s.mode, excluded.mode)
    returning id into v_session_id;
  exception when others then
    return json_build_object('ok', false, 'error', 'bad_request');
  end;

  -- ---- per-element: validate, insert-or-ignore, update mastery for NEW rows only ----
  for v_el in select * from jsonb_array_elements(p_batch->'attempts') loop
    v_result := v_el->>'result';
    v_attempt_id := null;
    begin
      v_attempt_id := (v_el->>'client_attempt_id')::uuid;
    exception when others then null;
    end;
    begin
      select * into v_skill from public.skills sk
       where sk.position = (v_el->>'stage_index')::int;
    exception when others then
      v_skill.id := null;
    end;
    if v_attempt_id is null or v_skill.id is null
       or v_result not in ('correct','incorrect','missed','invalid')
       or not (v_el->>'skill' = v_skill.category or (v_el->>'skill') = any(v_skill.alt_categories)) then
      v_rejected := v_rejected + 1;
      continue;
    end if;

    begin
      insert into public.attempts
        (child_id, session_id, skill_id, module_id, client_attempt_id, result,
         problem_text, correct_answer, chosen_answer, response_ms, input_method,
         asr_confidence, standard_code, run_time_s, level, stage_index, mode, model_version,
         context)                                       -- 0002: escape hatch
      values (
        v_child.id, v_session_id, v_skill.id,
        coalesce(p_batch->>'module_id', 'space-blasters'),
        v_attempt_id, v_result,
        left(v_el->>'problem_text', 64),
        (v_el->>'correct_answer')::int,
        (v_el->>'chosen_answer')::int,
        (v_el->>'response_ms')::int,
        v_el->>'input_method',
        (v_el->>'asr_confidence')::numeric,
        v_skill.ccss_codes[1],
        (v_el->>'run_time_s')::numeric,
        (v_el->>'level')::int,
        (v_el->>'stage_index')::int,
        p_batch->>'mode',
        'mastery-v1',
        coalesce(v_el->'context', '{}'::jsonb)          -- 0002: client-provided context, default {}
      )
      on conflict (child_id, client_attempt_id) do nothing
      returning id into v_inserted_id;
    exception when others then
      v_rejected := v_rejected + 1;
      continue;
    end;

    if v_inserted_id is null then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;
    v_inserted := v_inserted + 1;

    -- ---- mastery update (mirror of contracts/mastery.mjs, 'mastery-v1') ----
    v_counted := v_result <> 'invalid';
    if v_counted then
      v_correct := v_result = 'correct';
      select * into v_m from public.child_skill_mastery
       where child_id = v_child.id and skill_id = v_skill.id for update;
      if v_m.child_id is null then
        insert into public.child_skill_mastery
          (child_id, skill_id, alpha, beta, attempts_count, correct_count,
           last_seen_at, last_correct_at, model_version)
        values (v_child.id, v_skill.id,
                1 + case when v_correct then 1 else 0 end,
                1 + case when v_correct then 0 else 1 end,
                1, case when v_correct then 1 else 0 end,
                v_now, case when v_correct then v_now end, 'mastery-v1');
      else
        v_gap_days := greatest(0, extract(epoch from (v_now - v_m.last_seen_at)) / 86400.0);
        v_w := power(0.5, v_gap_days / v_m.decay_halflife_days);
        update public.child_skill_mastery set
          alpha = (1 + (v_m.alpha - 1) * v_w) + case when v_correct then 1 else 0 end,
          beta  = (1 + (v_m.beta  - 1) * v_w) + case when v_correct then 0 else 1 end,
          attempts_count = v_m.attempts_count + 1,
          correct_count  = v_m.correct_count + case when v_correct then 1 else 0 end,
          last_seen_at   = v_now,
          last_correct_at = case when v_correct then v_now else v_m.last_correct_at end,
          updated_at = v_now
        where child_id = v_child.id and skill_id = v_skill.id;
      end if;
      update public.sessions
         set attempts_count = attempts_count + 1,
             correct_count  = correct_count + case when v_correct then 1 else 0 end
       where id = v_session_id;
    end if;
  end loop;

  return json_build_object('ok', true,
    'inserted', v_inserted, 'duplicates', v_duplicates, 'rejected', v_rejected);
end $$;

revoke all on function public.record_attempts(text, text, jsonb) from public;
grant execute on function public.record_attempts(text, text, jsonb) to anon, authenticated, service_role;
