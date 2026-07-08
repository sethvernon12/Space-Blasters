-- ============================================================================
-- 0016_consent_kernel.sql — Phase 3.5 Slice a: verifiable-parental-consent kernel.
-- LOCAL ONLY, additive. Joins the Phase-3.5 SEC-03 review set before any DEV apply.
--
-- The parent's Stripe card transaction is the FTC-recognized VPC anchor (LEG-01).
-- A SIGNATURE-VERIFIED webhook (stripe-webhook) is the ONLY caller of grant_consent,
-- which ATOMICALLY: writes the immutable consent_ledger grant, creates the child
-- (with consent_id set — no child row exists before this), writes a family
-- entitlement, and audits. Idempotent on the Stripe event id. NO card data ever
-- (only Stripe reference ids in consent detail).
-- ============================================================================

-- idempotency ledger — one row per processed Stripe event (service-only)
create table if not exists public.stripe_events (
  event_id   text primary key,
  kind       text,
  child_id   uuid,
  created_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
alter table public.stripe_events force row level security;
revoke all on public.stripe_events from public, anon, authenticated;

-- family entitlement (one active per parent) — parent reads own; service writes
create table if not exists public.entitlements (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid not null unique,
  status     text not null default 'active' check (status in ('active', 'canceled')),
  source     text not null,
  created_at timestamptz not null default now()
);
alter table public.entitlements enable row level security;
alter table public.entitlements force row level security;
revoke all on public.entitlements from public, anon, authenticated;
grant select on public.entitlements to authenticated;
drop policy if exists entitlements_select on public.entitlements;
create policy entitlements_select on public.entitlements for select to authenticated
  using (parent_id = auth.uid());

-- ---- grant_consent: the VPC-anchored, atomic consent + child creation ----
create or replace function public.grant_consent(
  p_parent_id uuid, p_auth_user_id uuid, p_nickname text, p_grade_band text,
  p_method text, p_payment_ref text, p_policy_version text, p_event_id text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_child_id uuid; v_consent_id uuid; v_email text; v_last timestamptz;
begin
  if p_parent_id is null or p_auth_user_id is null or p_event_id is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  -- idempotency: an already-processed event returns its child, never a duplicate
  if exists (select 1 from public.stripe_events where event_id = p_event_id) then
    select child_id into v_child_id from public.stripe_events where event_id = p_event_id;
    return jsonb_build_object('ok', true, 'child_id', v_child_id, 'idempotent', true);
  end if;
  -- the parent must be an ADULT; the child identity must be a fresh @child.invalid
  if public.is_child_actor(p_parent_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- defense-in-depth (H1): the parent uid MUST be a real, non-child auth identity —
  -- rejects a garbage/non-existent uid. NOTE: this cannot tell one real parent from
  -- another, so the checkout endpoint (3.5b) MUST stamp metadata.parent_uid from the
  -- JWT-verified payer server-side (never a client field). Locked before that lands.
  if not exists (select 1 from auth.users where id = p_parent_id and coalesce(email, '') not like '%@child.invalid') then
    return jsonb_build_object('ok', false, 'error', 'invalid_parent');
  end if;
  select email, last_sign_in_at into v_email, v_last from auth.users where id = p_auth_user_id;
  if v_email is null or v_email not like '%@child.invalid' or v_last is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_child_identity'); end if;
  if exists (select 1 from public.children where auth_user_id = p_auth_user_id) then
    return jsonb_build_object('ok', false, 'error', 'already_registered'); end if;

  -- claim the event id FIRST (unique backstop against a concurrent duplicate)
  insert into public.stripe_events (event_id, kind) values (p_event_id, 'checkout.session.completed');
  -- child (consent_id null) -> immutable consent grant -> link consent_id
  insert into public.children (parent_id, auth_user_id, nickname, grade_band)
  values (p_parent_id, p_auth_user_id, left(coalesce(nullif(p_nickname, ''), 'Learner'), 40), nullif(left(coalesce(p_grade_band, ''), 8), ''))
  returning id into v_child_id;
  insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
  values (p_parent_id, v_child_id, 'grant', coalesce(p_method, 'stripe_card_transaction'), coalesce(p_policy_version, 'v1'),
          jsonb_build_object('payment_ref', p_payment_ref, 'event_id', p_event_id))   -- NEVER card data
  returning id into v_consent_id;
  update public.children set consent_id = v_consent_id where id = v_child_id;
  update public.stripe_events set child_id = v_child_id where event_id = p_event_id;
  insert into public.entitlements (parent_id, status, source) values (p_parent_id, 'active', 'stripe_consent')
    on conflict (parent_id) do nothing;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (p_parent_id, 'consent.grant', v_child_id, 'allow',
          jsonb_build_object('source', 'provisioning', 'method', coalesce(p_method, 'stripe_card_transaction'), 'event_id', p_event_id));
  return jsonb_build_object('ok', true, 'child_id', v_child_id, 'consent_id', v_consent_id);
exception when unique_violation then
  -- ONLY treat a real stripe_events(event_id) collision as idempotent; any OTHER
  -- unique_violation must NOT be masked as success (S1).
  select child_id into v_child_id from public.stripe_events where event_id = p_event_id;
  if not found then raise; end if;
  return jsonb_build_object('ok', true, 'child_id', v_child_id, 'idempotent', true);
end $$;
revoke all on function public.grant_consent(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.grant_consent(uuid, uuid, text, text, text, text, text, text) to service_role;
