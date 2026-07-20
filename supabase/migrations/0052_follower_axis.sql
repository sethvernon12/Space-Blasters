-- ============================================================================
-- 0052_follower_axis.sql — Phase 6 · Follow-Me · S3. THE FOLLOWER AXIS (crown jewel).
-- Opens a child's Follow-Me page to OUTSIDE followers WITHOUT ever exposing raw work, an
-- individual incident, or another child. The load-bearing property: is_scoped_follower is a
-- predicate DISJOINT from can_view_child (never an OR-branch on it; a follower holds no
-- tutor_grant and no guardian edge, so they match NONE of the raw-work read branches), and a
-- follower reads ONLY the narrow follow_me_public projection.
--
-- D1: one follower_circle per child (follower_circles map: child_id → circle group). D2: followers
-- do NOT see each other (follower_circle removed from group_adults_are_open; the parent manages the
-- roster via a definer RPC). D3: per-child 'activated' flag, default OFF (an approved follower reads
-- 0 until the parent turns followers on). D4: follow_me_public = first-name + FOL-9 star + essentials
-- (DISTINCT-LEADERS >=2, FOL-7) + achievements ONLY — no attempts/volume, no raw work, no incident.
-- Parent-vouch: a single-use 'follower' invite minted by the child's OWN parent (approved by name),
-- redeemed after the invitee signs in with Google/Apple (a traceable identity); NO payment (the $1 is
-- S4/giving). Removal is instant (deactivating the membership drops is_scoped_follower same-txn).
--
-- UNCHANGED: can_view_child / can_write_child / is_group_member / is_group_leader; the INTERIOR
-- branches of teaching_artifacts_select and every follow_me_* function (a parent/tutor still reads
-- the child's own private work of every scope — no self-inflicted interior break); the consent gate;
-- the isolation matrix. NO media/Stripe/live (S4+). Forward-only. DEV/local only.
-- ============================================================================

-- ---- D1: follower_circles map (one circle per child) + D3: the per-child activation flag ----
create table public.follower_circles (
  child_id   uuid primary key references public.children(id) on delete restrict,   -- covenant: explicit purge_child delete
  group_id   uuid not null references public.groups(id) on delete cascade,          -- the child's follower_circle group
  activated  boolean not null default false,                                        -- D3: default OFF (default-private)
  created_at timestamptz not null default now()
);
alter table public.follower_circles enable row level security;
alter table public.follower_circles force  row level security;
revoke all on public.follower_circles from public, anon;
grant select on public.follower_circles to authenticated;
-- the child's OWN parent reads the circle state (activation); NO client write (RPCs only).
create policy follower_circles_select on public.follower_circles for select to authenticated
  using (public.is_my_child(child_id));

-- ---- parent-vouch single-use follower invites (parent-minted, per child, name-approved) ----
create table public.follower_invites (
  id           uuid primary key default gen_random_uuid(),
  code_hash    text not null unique,                                                -- only the sha256 is stored
  child_id     uuid not null references public.children(id) on delete restrict,     -- covenant
  invited_name text not null,                                                        -- the parent approves the follower BY NAME
  created_by   uuid not null,                                                        -- the child's OWN parent
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  redeemed_by  uuid,
  status       text not null default 'pending' check (status in ('pending','redeemed','revoked')),
  created_at   timestamptz not null default now()
);
alter table public.follower_invites enable row level security;
alter table public.follower_invites force  row level security;
revoke all on public.follower_invites from public, anon;
grant select on public.follower_invites to authenticated;
-- the minting parent manages their own invites; NOBODY selects by code (redemption is the RPC only).
create policy follower_invites_select on public.follower_invites for select to authenticated
  using (created_by = auth.uid());

-- ---- provision_follower_circle: one circle per child (idempotent), internal ----
create or replace function public.provision_follower_circle(p_child_id uuid, p_parent uuid) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_gid uuid;
begin
  select group_id into v_gid from public.follower_circles where child_id = p_child_id;
  if v_gid is not null then return v_gid; end if;
  insert into public.groups (purpose, name, created_by) values ('follower_circle', 'Follow Me', p_parent) returning id into v_gid;
  insert into public.follower_circles (child_id, group_id) values (p_child_id, v_gid) on conflict (child_id) do nothing;
  if not found then                                       -- a concurrent mint won the race; drop the orphan group, use theirs
    delete from public.groups where id = v_gid;
    select group_id into v_gid from public.follower_circles where child_id = p_child_id;
  end if;
  return v_gid;
end $$;
revoke all on function public.provision_follower_circle(uuid, uuid) from public, anon, authenticated;  -- internal only

-- ---- is_scoped_follower — THE DISJOINT PREDICATE (never an OR-branch on can_view_child) ----
-- True iff the caller holds an ACTIVE 'follower' membership in THIS child's ACTIVATED circle. Reads
-- ONLY follower_circles + memberships — never is_my_child, never tutor_grants, never can_view_child.
create or replace function public.is_scoped_follower(p_child_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.follower_circles fc
    join public.memberships m on m.group_id = fc.group_id
    where fc.child_id = p_child_id and fc.activated                                  -- D3: default-private until activated
      and m.member_actor_id = auth.uid() and m.member_child_id is null
      and m.role = 'follower' and m.active                                           -- an ACTIVE follower membership (instant removal = deactivate)
  )
$$;
revoke all on function public.is_scoped_follower(uuid) from public, anon;
grant execute on function public.is_scoped_follower(uuid) to authenticated;

-- ---- mint_follower_invite: the child's OWN parent mints a single-use, name-approved invite ----
create or replace function public.mint_follower_invite(p_child_id uuid, p_invited_name text, p_ttl_hours int default 336)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_code text; v_hash text; v_id uuid; v_circle uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- the parent, never the child
  if not public.is_my_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if public.actor_is_deleted(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not public.has_active_consent(p_child_id) then return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  if p_invited_name is null or length(btrim(p_invited_name)) = 0 then return jsonb_build_object('ok', false, 'error', 'name_required'); end if;
  v_circle := public.provision_follower_circle(p_child_id, v_uid);                    -- one circle per child (idempotent)
  v_code := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_hash := encode(extensions.digest(convert_to(v_code, 'utf8'), 'sha256'), 'hex');
  insert into public.follower_invites (code_hash, child_id, invited_name, created_by, expires_at)
    values (v_hash, p_child_id, left(btrim(p_invited_name), 120), v_uid, now() + make_interval(hours => greatest(1, coalesce(p_ttl_hours, 336))))
    returning id into v_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'follower.invite.mint', p_child_id, 'allow', jsonb_build_object('invite_id', v_id));  -- ids only; the name lives in follower_invites (which purge_child deletes) — data-minimization + deletion-completeness (parity with mint_invitation)
  return jsonb_build_object('ok', true, 'invite_id', v_id, 'code', v_code);            -- plaintext returned ONCE
end $$;
revoke all on function public.mint_follower_invite(uuid, text, int) from public, anon;
grant execute on function public.mint_follower_invite(uuid, text, int) to authenticated;

-- ---- redeem_follower_invite: the invitee (signed in via Google/Apple) becomes a scoped follower ----
create or replace function public.redeem_follower_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_hash text; v_inv public.follower_invites%rowtype; v_gid uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;        -- OAuth required (a real signed-in identity)
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- a child login can never be a follower
  if public.actor_is_deleted(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- zombie-write guard (parity with mint): a captured post-purge JWT cannot become a follower
  if p_code is null or length(btrim(p_code)) < 8 then return jsonb_build_object('ok', false, 'error', 'invalid_or_used'); end if;
  v_hash := encode(extensions.digest(convert_to(btrim(p_code), 'utf8'), 'sha256'), 'hex');
  select * into v_inv from public.follower_invites where code_hash = v_hash and status = 'pending' and expires_at > now() for update;
  if v_inv.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_used'); end if;
  select group_id into v_gid from public.follower_circles where child_id = v_inv.child_id;
  if v_gid is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_used'); end if;
  -- the follower membership (member_child_id NULL, role 'follower'); idempotent
  if not exists (select 1 from public.memberships where group_id = v_gid and member_actor_id = v_uid and member_child_id is null) then
    insert into public.memberships (group_id, member_actor_id, role, active) values (v_gid, v_uid, 'follower', true);
  else
    update public.memberships set active = true, role = 'follower', left_at = null where group_id = v_gid and member_actor_id = v_uid and member_child_id is null;
  end if;
  update public.follower_invites set status = 'redeemed', redeemed_at = now(), redeemed_by = v_uid where id = v_inv.id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'follower.invite.redeem', v_inv.child_id, 'allow', jsonb_build_object('invite_id', v_inv.id));
  return jsonb_build_object('ok', true, 'child_id', v_inv.child_id);
end $$;
revoke all on function public.redeem_follower_invite(text) from public, anon;
grant execute on function public.redeem_follower_invite(text) to authenticated;

-- ---- set_followers_activated (D3) + remove_follower (instant) + my_follower_roster (parent-managed) ----
create or replace function public.set_followers_activated(p_child_id uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor_self() or not public.is_my_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  perform public.provision_follower_circle(p_child_id, v_uid);
  update public.follower_circles set activated = coalesce(p_on, false) where child_id = p_child_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'follower.activate', p_child_id, 'allow', jsonb_build_object('activated', coalesce(p_on, false)));
  return jsonb_build_object('ok', true, 'activated', coalesce(p_on, false));
end $$;
revoke all on function public.set_followers_activated(uuid, boolean) from public, anon;
grant execute on function public.set_followers_activated(uuid, boolean) to authenticated;

create or replace function public.remove_follower(p_child_id uuid, p_follower_actor uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_n int;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor_self() or not public.is_my_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  update public.memberships set active = false, left_at = now()
   where group_id = (select group_id from public.follower_circles where child_id = p_child_id)
     and member_actor_id = p_follower_actor and member_child_id is null and role = 'follower';
  get diagnostics v_n = row_count;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'follower.remove', p_child_id, 'allow', jsonb_build_object('follower', p_follower_actor, 'removed', v_n));
  return jsonb_build_object('ok', true, 'removed', v_n);        -- is_scoped_follower drops SAME-TXN (membership now inactive)
end $$;
revoke all on function public.remove_follower(uuid, uuid) from public, anon;
grant execute on function public.remove_follower(uuid, uuid) to authenticated;

create or replace function public.my_follower_roster(p_child_id uuid)
returns table (follower_actor_id uuid, active boolean, joined_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select m.member_actor_id, m.active, m.created_at
  from public.follower_circles fc
  join public.memberships m on m.group_id = fc.group_id
  where fc.child_id = p_child_id and m.member_child_id is null and m.role = 'follower'
    and public.is_my_child(p_child_id) and not public.is_child_actor_self()          -- PARENT-managed roster (D2: followers never see this)
  order by m.created_at
$$;
revoke all on function public.my_follower_roster(uuid) from public, anon;
grant execute on function public.my_follower_roster(uuid) to authenticated;

-- ---- essentials_score_public: the DISTINCT-LEADERS floor for the follower surface (FOL-7) ----
-- Identical to essentials_score EXCEPT the floor: >= 2 DISTINCT leaders (a single leader's ratings
-- are never a follower-visible 'average'). Definer-only — reached solely via follow_me_public.
create or replace function public.essentials_score_public(p_child_id uuid) returns numeric
language sql stable security definer set search_path = ''
as $$
  with latest as (
    select distinct on (e.author_actor_id, e.payload->>'essential') e.author_actor_id, (e.payload->>'stars')::numeric as stars
    from public.events e
    where e.kind = 'rating' and e.subject_child_id = p_child_id
      and e.payload->>'role' = 'leader'
      and e.payload->>'week' = to_char(date_trunc('week', now() at time zone 'UTC'), 'YYYY-MM-DD')
    order by e.author_actor_id, e.payload->>'essential', (e.payload->>'rated_at')::timestamptz desc
  )
  select case when count(distinct author_actor_id) >= 2 then round(avg(stars), 1) else null end from latest
$$;
revoke all on function public.essentials_score_public(uuid) from public, anon, authenticated;  -- definer-only; via follow_me_public

-- ---- follow_me_public: THE FOLLOWER-FACING SURFACE — narrow projection, fail-closed on is_scoped_follower ----
-- D4: first-name + FOL-9 star + essentials(distinct-leaders) + achievements ONLY. No practice_count/
-- volume, no raw work, no incident. Fail-closed: the caller must be a SCOPED FOLLOWER of THIS child
-- (re-checked in the body, never trusting the param — SF-1) AND the surface activated AND consent live.
create or replace function public.follow_me_public(p_child_id uuid)
returns table (first_name text, faithfulness_star int, essentials_avg numeric, achievements int)
language sql stable security definer set search_path = ''
as $$
  with m as (
    select coalesce(sum(cm.attempts_count), 0) as practice, avg(cm.mastery) as avg_mastery,
           count(*) filter (where cm.mastery >= 0.85 and cm.attempts_count >= 5) as fluent
    from public.child_skill_mastery cm where cm.child_id = p_child_id
  )
  select (select ch.nickname from public.children ch where ch.id = p_child_id),          -- first-name-only
         greatest(1, least(10, round(10 * (0.6 * least(1.0, m.practice / 50.0) + 0.4 * coalesce(m.avg_mastery, 0)))))::int,
         public.essentials_score_public(p_child_id),                                     -- distinct-leaders floored
         m.fluent::int                                                                   -- achievements (fluency count); NO practice_count/volume
  from m
  where public.is_scoped_follower(p_child_id)                                            -- DISJOINT from can_view_child; activation + active membership
    and public.has_active_consent(p_child_id)                                            -- revocation drops the page
    and m.practice > 0                                                                   -- empty aggregate → no page
$$;
revoke all on function public.follow_me_public(uuid) from public, anon;
grant execute on function public.follow_me_public(uuid) to authenticated;

-- ---- VISIBILITY ENFORCEMENT (surgical + additive): teaching_artifacts_select gains a follower branch ----
-- The two INTERIOR branches are byte-identical to 0006 (can_view_child + private-gating) — a parent/
-- tutor still reads the child's own work of every scope. The NEW top-level OR is the follower branch:
-- a scoped follower reads ONLY 'followers'-scoped artifacts of a consented child — NEVER can_view_child,
-- NEVER private/family/staff scopes. Inert in S3 (no 'followers' media until S5); establishes the pattern.
drop policy teaching_artifacts_select on public.teaching_artifacts;
create policy teaching_artifacts_select on public.teaching_artifacts for select to authenticated
  using (
    (public.can_view_child(child_id) and public.has_active_consent(child_id)
     and (visibility_scope <> 'private' or author_id = auth.uid() or public.is_guardian(child_id)))
    or
    (public.is_scoped_follower(child_id) and public.has_active_consent(child_id) and visibility_scope = 'followers')
  );

-- ---- D2: followers do NOT see each other — remove follower_circle from group_adults_are_open ----
-- family/class/team keep within-group adult visibility (communication); a follower_circle's adults are
-- NOT mutually open, so a follower reads only their OWN membership row (memberships_select adult branch).
-- The parent manages the roster via my_follower_roster (definer). A FUTURE purpose stays restrictive.
create or replace function public.group_adults_are_open(p_group_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.id = p_group_id and g.purpose in ('family','class','team')
  )
$$;
revoke all on function public.group_adults_are_open(uuid) from public, anon;
grant execute on function public.group_adults_are_open(uuid) to authenticated;

-- ---- deletion covenant: purge_child deletes the child's follower invites + circle (+ its follower
-- memberships via the group's ON DELETE CASCADE) + the follower_circles map. Identical to 0046 except
-- the added follower block + disposition counts. ----
create or replace function public.purge_child(p_child_id uuid, p_parent_id uuid, p_deleting_actor uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_child public.children%rowtype;
  v_auth_user uuid; v_revoke_id uuid; v_receipt public.deletion_receipts%rowtype;
  v_prev_hash text; v_hash text; v_disp jsonb; v_ent text := 'kept'; v_circle uuid;
  d_attempts int; d_sessions int; d_mastery int; d_misc int; d_assess int;
  d_assign int; d_subs int; d_arts int; d_mints int; d_grants int;
  d_mem int; d_chmem int; d_outbox int; d_subjevents int; t_msgs int; d_uploads int; d_inv int;
  d_gjobs int; d_gprop int; d_gledger int; d_mreq int; d_removals int; d_finv int; d_fcmap int; d_fcircle int; d_fmem int;
begin
  if p_child_id is null or p_parent_id is null or p_deleting_actor is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  perform set_config('lock_timeout', '5000', true);
  perform set_config('statement_timeout', '30000', true);

  select * into v_receipt from public.deletion_receipts where child_id = p_child_id;
  if v_receipt.id is not null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'receipt_id', v_receipt.id,
      'child_auth_user_id', v_receipt.child_auth_user_id, 'status', v_receipt.status,
      'receipt_hash', v_receipt.receipt_hash, 'disposition', v_receipt.disposition);
  end if;

  select * into v_child from public.children where id = p_child_id for update;
  if v_child.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_child.parent_id is distinct from p_parent_id then
    return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  v_auth_user := v_child.auth_user_id;

  if exists (select 1 from public.legal_holds where child_id = p_child_id and released_at is null) then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (p_deleting_actor, 'child.delete', p_child_id, 'deny', jsonb_build_object('reason', 'legal_hold', 'source', 'deletion'));
    return jsonb_build_object('ok', false, 'error', 'legal_hold');
  end if;

  perform set_config('app.purge', 'on', true);

  insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
  values (p_parent_id, p_child_id, 'revoke',
          coalesce((select method from public.consent_ledger where child_id = p_child_id and action = 'grant' order by created_at limit 1), 'other_vpc'),
          coalesce((select policy_version from public.consent_ledger where child_id = p_child_id and action = 'grant' order by created_at desc limit 1), 'v1'),
          jsonb_build_object('source', 'deletion', 'deleting_actor', p_deleting_actor))
  returning id into v_revoke_id;

  if v_auth_user is not null then
    update public.events
       set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{body}', to_jsonb('[removed: child record deleted]'::text))
     where kind = 'message' and author_actor_id = v_auth_user;
    get diagnostics t_msgs = row_count;
  else t_msgs := 0; end if;

  delete from public.attempts where child_id = p_child_id;                    get diagnostics d_attempts = row_count;
  delete from public.submissions where child_id = p_child_id;                 get diagnostics d_subs = row_count;
  delete from public.teaching_artifacts where child_id = p_child_id;          get diagnostics d_arts = row_count;
  delete from public.grade_proposals where child_id = p_child_id;             get diagnostics d_gprop = row_count;
  delete from public.grade_jobs where child_id = p_child_id;                  get diagnostics d_gjobs = row_count;
  delete from public.grade_cost_ledger where child_id = p_child_id;           get diagnostics d_gledger = row_count;
  delete from public.uploads where child_id = p_child_id;                     get diagnostics d_uploads = row_count;
  delete from public.invitations where target_child_id = p_child_id;          get diagnostics d_inv = row_count;
  delete from public.child_skill_mastery where child_id = p_child_id;          get diagnostics d_mastery = row_count;
  delete from public.child_skill_misconception where child_id = p_child_id;    get diagnostics d_misc = row_count;
  delete from public.child_skill_assessment where child_id = p_child_id;       get diagnostics d_assess = row_count;
  delete from public.sessions where child_id = p_child_id;                     get diagnostics d_sessions = row_count;
  delete from public.assignments where child_id = p_child_id;                  get diagnostics d_assign = row_count;
  delete from public.child_session_mints where child_id = p_child_id;          get diagnostics d_mints = row_count;
  delete from public.tutor_grants where child_id = p_child_id;                 get diagnostics d_grants = row_count;
  delete from public.membership_requests where member_child_id = p_child_id;   get diagnostics d_mreq = row_count;
  delete from public.membership_removals where member_child_id = p_child_id;   get diagnostics d_removals = row_count;
  -- S3 follower axis: invites (child-keyed) + the circle group (its follower memberships cascade via
  -- memberships.group_id ON DELETE CASCADE) + the follower_circles map. Delete the map before the group.
  delete from public.follower_invites where child_id = p_child_id;            get diagnostics d_finv = row_count;
  select group_id into v_circle from public.follower_circles where child_id = p_child_id;
  delete from public.follower_circles where child_id = p_child_id;            get diagnostics d_fcmap = row_count;
  if v_circle is not null then
    select count(*)::int into d_fmem from public.memberships where group_id = v_circle;   -- followers cut by the group cascade (audit completeness)
    delete from public.groups where id = v_circle; get diagnostics d_fcircle = row_count;
  else d_fcircle := 0; d_fmem := 0; end if;
  delete from public.memberships where member_child_id = p_child_id;           get diagnostics d_mem = row_count;
  delete from public.channel_members where member_child_id = p_child_id;       get diagnostics d_chmem = row_count;
  delete from public.derivation_outbox where member_child_id = p_child_id;     get diagnostics d_outbox = row_count;
  delete from public.events where subject_child_id = p_child_id;               get diagnostics d_subjevents = row_count;

  delete from public.children where id = p_child_id;

  if not exists (select 1 from public.children where parent_id = p_parent_id) then
    update public.entitlements set status = 'canceled' where parent_id = p_parent_id and status = 'active';
    if found then v_ent := 'canceled_last_child'; end if;
  end if;

  v_disp := jsonb_build_object(
    'deleted', jsonb_build_object('attempts', d_attempts, 'sessions', d_sessions, 'child_skill_mastery', d_mastery,
      'child_skill_misconception', d_misc, 'child_skill_assessment', d_assess, 'assignments', d_assign,
      'submissions', d_subs, 'teaching_artifacts', d_arts, 'uploads', d_uploads, 'invitations', d_inv,
      'grade_jobs', d_gjobs, 'grade_proposals', d_gprop, 'grade_cost_ledger', d_gledger,
      'child_session_mints', d_mints, 'tutor_grants', d_grants, 'membership_requests', d_mreq, 'membership_removals', d_removals,
      'follower_invites', d_finv, 'follower_circles', d_fcmap, 'follower_circle_groups', d_fcircle, 'follower_memberships', d_fmem,
      'memberships', d_mem, 'channel_members', d_chmem,
      'derivation_outbox', d_outbox, 'subject_events', d_subjevents, 'children', 1),
    'tombstoned', jsonb_build_object('authored_messages', t_msgs),
    'retained', jsonb_build_array('consent_ledger', 'audit_log', 'stripe_events', 'deletion_receipts'),
    'entitlement', v_ent);
  perform pg_advisory_xact_lock(hashtext('deletion_receipts_chain'));
  select receipt_hash into v_prev_hash from public.deletion_receipts order by created_at desc, id desc limit 1;
  v_hash := encode(extensions.digest(convert_to(
      coalesce(v_prev_hash, '') || '|' || p_child_id::text || '|' || p_parent_id::text || '|' ||
      coalesce(v_auth_user::text, '') || '|' || p_deleting_actor::text || '|' || coalesce(v_revoke_id::text, '') || '|' ||
      v_disp::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.deletion_receipts (child_id, parent_id, child_auth_user_id, deleting_actor, revoke_consent_id, disposition, prev_receipt_hash, receipt_hash, status)
  values (p_child_id, p_parent_id, v_auth_user, p_deleting_actor, v_revoke_id, v_disp, v_prev_hash, v_hash, 'pending_auth_cleanup')
  returning * into v_receipt;

  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (p_deleting_actor, 'child.delete', p_child_id, 'allow',
          jsonb_build_object('source', 'deletion', 'receipt_id', v_receipt.id, 'child_auth_user_id', v_auth_user, 'disposition', v_disp));

  return jsonb_build_object('ok', true, 'receipt_id', v_receipt.id, 'child_auth_user_id', v_auth_user,
    'status', 'pending_auth_cleanup', 'disposition', v_disp, 'receipt_hash', v_hash);
end $$;
revoke all on function public.purge_child(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_child(uuid, uuid, uuid) to service_role;
