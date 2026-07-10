-- ============================================================================
-- 0017_consent_minimize.sql — Phase A0 (deletion-phase prerequisite): keep the
-- child's nickname/grade OUT of Stripe, so "delete = zero child data anywhere"
-- (AC-1) is actually achievable. LOCAL ONLY, additive; joins the A0 mini-review
-- (checklist floor: MUST-FIX #1 minimization + #6 refund/dispute no-op) before
-- any DEV apply.
--
-- BEFORE: create-consent-checkout stamped metadata.nickname + metadata.grade, so
-- the child's nickname was disclosed to Stripe (a sub-processor) and could not be
-- reached by our deletion path. AFTER: the nickname/grade are stashed in a
-- short-lived, service-only `pending_children` row keyed by an OPAQUE token; only
-- that token + the (non-PII) parent_uid ride in Stripe metadata. The
-- signature-verified webhook resolves the token → grant_consent creates the child
-- and CONSUMES (deletes) the pending row, all atomically. Nickname never leaves
-- Postgres. Abandoned checkouts are swept by an AUDITED TTL cleanup.
--
-- DEFINER HYGIENE (stated, per SHOULD-FIX): every function here is SECURITY
-- DEFINER, `set search_path = ''`, fully schema-qualified, EXECUTE revoked from
-- public/anon/authenticated and granted only where a caller legitimately needs it.
-- ============================================================================

-- ---- pending_children: parent's pre-consent intent (nickname+grade), transient.
-- Service/definer-only: NO client (anon/authenticated) can read or write it, so a
-- pre-consent nickname is never exposed through PostgREST. It is NOT a child
-- profile (no auth identity, no learning data) and is deleted the instant consent
-- lands, or swept when the checkout is abandoned.
create table if not exists public.pending_children (
  token      uuid primary key default gen_random_uuid(),
  parent_id  uuid not null,
  nickname   text not null check (char_length(nickname) between 1 and 40),
  grade_band text,
  created_at timestamptz not null default now(),
  -- 48h > Stripe's 24h Checkout Session lifetime, so a genuinely completed
  -- checkout's pending row is NEVER expired when the webhook resolves it; only
  -- abandoned (never-paid) rows age out and get swept.
  expires_at timestamptz not null default (now() + interval '48 hours')
);
create index if not exists pending_children_parent_idx on public.pending_children (parent_id);
create index if not exists pending_children_expires_idx on public.pending_children (expires_at);
alter table public.pending_children enable row level security;
alter table public.pending_children force row level security;
-- Deliberately NO `grant ... to service_role`: every access is via the SECURITY
-- DEFINER RPCs below (which run as the table-owning role), so the table stays
-- unreachable by ANY client role — deny-by-default with no SELECT policy.
revoke all on public.pending_children from public, anon, authenticated;   -- service/definer only

-- ---- cleanup_pending_children(): AUDITED TTL sweep of abandoned checkouts.
-- Deletes only rows past their TTL. Writes ONE audit row per sweep that actually
-- deleted something (no noise when there is nothing to sweep). Idempotent.
-- Intended callers: the opportunistic sweep inside create_pending_child, and a
-- scheduled job (pg_cron) in DEV/prod — designed now, wired at deploy.
create or replace function public.cleanup_pending_children()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_deleted int;
begin
  with del as (delete from public.pending_children where expires_at < now() returning 1)
  select count(*) into v_deleted from del;
  if v_deleted > 0 then
    -- system-initiated maintenance: sentinel actor, no child scope, count only
    -- (never a nickname) — keeps the audit trail PII-free.
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values ('00000000-0000-0000-0000-000000000000', 'consent.pending_cleanup', null, 'allow',
            jsonb_build_object('deleted', v_deleted, 'source', 'ttl_sweep'));
  end if;
  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end $$;
revoke all on function public.cleanup_pending_children() from public, anon, authenticated;
grant execute on function public.cleanup_pending_children() to service_role;

-- ---- create_pending_child(): the ONLY way to create a pending row. Callable by
-- an authenticated ADULT; stamps parent_id = auth.uid() SERVER-SIDE (a client can
-- never forge whose child it is), rejects child actors, opportunistically sweeps
-- abandoned rows, and returns the OPAQUE token for the checkout metadata.
create or replace function public.create_pending_child(p_nickname text, p_grade_band text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_nick text; v_token uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  -- children never start a consent checkout (adult-only, mirrors the Edge gate)
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_nick := left(btrim(coalesce(p_nickname, '')), 40);
  if v_nick = '' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  -- opportunistic, audited sweep of abandoned checkouts on every new one
  perform public.cleanup_pending_children();
  -- anti-accumulation cap: bound how many LIVE (post-sweep) pending rows one parent
  -- can hold, so a scripted adult can't inflate the table. 20 is far above any real
  -- family's concurrent add-a-child flows; abandoned rows age out at the 48h TTL.
  if (select count(*) from public.pending_children where parent_id = v_uid) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many_pending'); end if;
  insert into public.pending_children (parent_id, nickname, grade_band)
  values (v_uid, v_nick, nullif(left(coalesce(p_grade_band, ''), 8), ''))
  returning token into v_token;
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;
revoke all on function public.create_pending_child(text, text) from public, anon;
grant execute on function public.create_pending_child(text, text) to authenticated;

-- ---- grant_consent (REVISED): resolve the child's nickname/grade from the
-- OPAQUE pending token (not from Stripe metadata) and CONSUME the pending row in
-- the same transaction. Replaces the 0016 (…, p_nickname, p_grade_band, …)
-- signature. Everything else — idempotency on the Stripe event id, the H1
-- adult-parent check, the fresh-@child.invalid identity check, immutable grant,
-- entitlement, audit — is unchanged.
drop function if exists public.grant_consent(uuid, uuid, text, text, text, text, text, text);
create or replace function public.grant_consent(
  p_parent_id uuid, p_auth_user_id uuid, p_pending_token uuid,
  p_method text, p_payment_ref text, p_policy_version text, p_event_id text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_child_id uuid; v_consent_id uuid; v_email text; v_last timestamptz;
        v_nick text; v_grade text; v_pending_parent uuid;
begin
  if p_parent_id is null or p_auth_user_id is null or p_pending_token is null or p_event_id is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  -- idempotency: an already-processed event returns its child, never a duplicate
  -- (pending row is already consumed by the first success — not needed on replay)
  if exists (select 1 from public.stripe_events where event_id = p_event_id) then
    select child_id into v_child_id from public.stripe_events where event_id = p_event_id;
    return jsonb_build_object('ok', true, 'child_id', v_child_id, 'idempotent', true);
  end if;
  -- the parent must be an ADULT identity
  if public.is_child_actor(p_parent_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- defense-in-depth (H1): parent uid MUST be a real, non-child auth identity.
  -- (The checkout endpoint stamps metadata.parent_uid from the JWT-verified payer;
  -- this rejects a garbage/non-existent uid.)
  if not exists (select 1 from auth.users where id = p_parent_id and coalesce(email, '') not like '%@child.invalid') then
    return jsonb_build_object('ok', false, 'error', 'invalid_parent');
  end if;
  select email, last_sign_in_at into v_email, v_last from auth.users where id = p_auth_user_id;
  if v_email is null or v_email not like '%@child.invalid' or v_last is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_child_identity'); end if;
  if exists (select 1 from public.children where auth_user_id = p_auth_user_id) then
    return jsonb_build_object('ok', false, 'error', 'already_registered'); end if;

  -- resolve the child's nickname/grade from the pending token (payment completed =
  -- authoritative → resolve regardless of TTL; only abandoned rows are swept). The
  -- pending row's parent MUST match the server-stamped payer.
  select parent_id, nickname, grade_band into v_pending_parent, v_nick, v_grade
    from public.pending_children where token = p_pending_token;
  if v_nick is null then return jsonb_build_object('ok', false, 'error', 'pending_not_found'); end if;
  if v_pending_parent is distinct from p_parent_id then
    return jsonb_build_object('ok', false, 'error', 'pending_parent_mismatch'); end if;

  -- claim the event id FIRST (unique backstop against a concurrent duplicate)
  insert into public.stripe_events (event_id, kind) values (p_event_id, 'checkout.session.completed');
  -- child (consent_id null) -> immutable consent grant -> link consent_id
  insert into public.children (parent_id, auth_user_id, nickname, grade_band)
  values (p_parent_id, p_auth_user_id, left(coalesce(nullif(v_nick, ''), 'Learner'), 40), nullif(left(coalesce(v_grade, ''), 8), ''))
  returning id into v_child_id;
  insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
  values (p_parent_id, v_child_id, 'grant', coalesce(p_method, 'stripe_card_transaction'), coalesce(p_policy_version, 'v1'),
          jsonb_build_object('payment_ref', p_payment_ref, 'event_id', p_event_id))   -- NEVER card data, NEVER nickname
  returning id into v_consent_id;
  update public.children set consent_id = v_consent_id where id = v_child_id;
  update public.stripe_events set child_id = v_child_id where event_id = p_event_id;
  insert into public.entitlements (parent_id, status, source) values (p_parent_id, 'active', 'stripe_consent')
    on conflict (parent_id) do nothing;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (p_parent_id, 'consent.grant', v_child_id, 'allow',
          jsonb_build_object('source', 'provisioning', 'method', coalesce(p_method, 'stripe_card_transaction'), 'event_id', p_event_id));
  -- consume the pending row: the nickname now lives only on the (deletable) child row
  delete from public.pending_children where token = p_pending_token;
  return jsonb_build_object('ok', true, 'child_id', v_child_id, 'consent_id', v_consent_id);
exception when unique_violation then
  -- ONLY a real stripe_events(event_id) collision is idempotent success; any OTHER
  -- unique_violation must NOT be masked (S1).
  select child_id into v_child_id from public.stripe_events where event_id = p_event_id;
  if not found then raise; end if;
  return jsonb_build_object('ok', true, 'child_id', v_child_id, 'idempotent', true);
end $$;
revoke all on function public.grant_consent(uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.grant_consent(uuid, uuid, uuid, text, text, text, text) to service_role;
