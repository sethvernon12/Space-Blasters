-- ============================================================================
-- 0023_academy_invitations.sql — Slice AR-4: Academy acceptance-key redemption +
-- invitation-led tutor/coach grants, folding in SEC-REV-26. LOCAL ONLY, additive.
-- MUST pass SEC-03 + the cross-family/cross-academy isolation e2e before any
-- DEV/prod apply (bundled with 0021+0022 at the end-of-phase gated apply).
--
-- Academy-controlled trust (never self-declaration, never a stranger's invite):
-- the Academy ADMIN mints one-time bearer keys server-side (mint_invitation — no
-- self-serve issuance UI this phase); a signed-in adult redeems a key in the lobby
-- (redeem_invitation, fail-closed). enrolled_parent → an arena='academy' family
-- linked to the Academy (enrollment IS the consent, LEG-02); tutor/coach → a
-- SCOPED, revocable tutor_grant to EXACTLY the invited child, attributed to the
-- child's enrolled parent (granted_by=parent) so the parent always sees who has
-- access (transparency) with NO RLS-policy recursion.
--
-- SEC-REV-26 (folded in): re-key family_standing to the STABLE Google identity
-- (auth.identities `sub`) so a delete + re-signup (new auth.users.id) can no longer
-- shed a sanction. Standing is the anti-evasion anchor; the churn-cap keeps its
-- uid-based window (immutable deletion_receipts are not re-keyed).
--
-- DEFINER HYGIENE: every function SECURITY DEFINER, search_path='', schema-
-- qualified, EXECUTE service/authenticated only.
-- ============================================================================

-- ============================ SEC-REV-26 ============================
-- The durable person id across account delete + re-signup: the Google `sub`
-- (auth.identities.provider_id, provider='google'); falls back to uid::text for
-- non-Google (dev) users so LOCAL still works.
create or replace function public.stable_subject(p_uid uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select i.provider_id from auth.identities i
      where i.user_id = p_uid and i.provider = 'google' limit 1),
    p_uid::text)
$$;
revoke all on function public.stable_subject(uuid) from public, anon;
grant execute on function public.stable_subject(uuid) to authenticated;

-- re-key family_standing onto the stable subject (parent_id kept for readability =
-- the most-recent uid seen). Backfill existing rows, then a unique index on subject
-- makes it the durable anti-evasion key.
alter table public.family_standing add column if not exists subject text;
update public.family_standing set subject = public.stable_subject(parent_id) where subject is null;
-- de-dupe any pre-existing rows that already resolve to the SAME stable subject (the
-- exact evasion case this fix closes), keeping the MOST-sanctioned, before the unique
-- index — so the re-key apply is self-safe even over historical duplicates.
delete from public.family_standing a using public.family_standing b
  where a.subject = b.subject and a.ctid <> b.ctid
    and (a.flags < b.flags or (a.flags = b.flags and a.ctid < b.ctid));
create unique index if not exists family_standing_subject_uniq on public.family_standing (subject);

-- record_family_flag now upserts on SUBJECT (survives a re-signup); same escalation.
create or replace function public.record_family_flag(p_parent_id uuid, p_reason text, p_mute_minutes int default 0)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_flags int; v_standing text; v_subject text;
begin
  if p_parent_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  v_subject := public.stable_subject(p_parent_id);
  insert into public.family_standing (parent_id, subject, flags, muted_until, standing)
  values (p_parent_id, v_subject, 1,
          case when coalesce(p_mute_minutes, 0) > 0 then now() + make_interval(mins => p_mute_minutes) else null end, 'good')
  on conflict (subject) do update set
    flags = public.family_standing.flags + 1,
    parent_id = excluded.parent_id,   -- track the latest uid for this durable subject
    muted_until = case when coalesce(p_mute_minutes, 0) > 0 then now() + make_interval(mins => p_mute_minutes)
                       else public.family_standing.muted_until end,
    updated_at = now()
  returning flags into v_flags;
  v_standing := case when v_flags >= 5 then 'suspended' when v_flags >= 3 then 'limited' else 'good' end;
  update public.family_standing set standing = v_standing where subject = v_subject;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values ('00000000-0000-0000-0000-000000000000', 'family.flag', null, 'allow',
          jsonb_build_object('subject', v_subject, 'flags', v_flags, 'standing', v_standing, 'reason', left(coalesce(p_reason, ''), 200)));
  return jsonb_build_object('ok', true, 'flags', v_flags, 'standing', v_standing);
end $$;
revoke all on function public.record_family_flag(uuid, text, int) from public, anon, authenticated;
grant execute on function public.record_family_flag(uuid, text, int) to service_role;

-- family_muted now resolves the actor → family head → STABLE SUBJECT → standing.
create or replace function public.family_muted(p_uid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.family_standing fs
    where fs.subject = public.stable_subject(public.family_of(p_uid))
      and (fs.standing = 'suspended' or (fs.muted_until is not null and fs.muted_until > now()))
  )
$$;
revoke all on function public.family_muted(uuid) from public, anon;
grant execute on function public.family_muted(uuid) to authenticated;

-- ============================ Academy invitations ============================
-- One-time bearer keys the Academy mints and hands out. Only the code HASH is
-- stored (bearer secret); the plaintext is returned once at mint time.
create table if not exists public.invitations (
  id              uuid primary key default gen_random_uuid(),
  code_hash       text not null unique,
  kind            text not null check (kind in ('enrolled_parent', 'tutor', 'coach')),
  academy_id      uuid not null references public.groups(id) on delete cascade,   -- a purpose='academy' group
  target_child_id uuid references public.children(id) on delete cascade,          -- tutor/coach: the invited child
  can_write       boolean not null default true,
  created_by      uuid not null,                 -- the Academy admin (auth.users.id)
  expires_at      timestamptz not null,
  redeemed_at     timestamptz,
  redeemed_by     uuid,
  status          text not null default 'pending' check (status in ('pending', 'redeemed', 'revoked')),
  created_at      timestamptz not null default now()
);
create index invitations_academy_idx on public.invitations (academy_id);
alter table public.invitations enable row level security;
alter table public.invitations force row level security;
revoke all on public.invitations from public, anon, authenticated;
grant select on public.invitations to authenticated;   -- the Academy admin reads its own (below)
-- the minting admin can see/manage their academy's invitations; NOBODY selects by
-- code (redemption is the RPC only) — so a redeemer can't enumerate keys.
drop policy if exists invitations_admin_select on public.invitations;
create policy invitations_admin_select on public.invitations for select to authenticated
  using (created_by = auth.uid());
-- NO client insert/update/delete: mint_invitation / redeem_invitation (definer) only.

-- mint_invitation — ONLY the Academy's own admin (its group creator) may mint.
create or replace function public.mint_invitation(
  p_academy_id uuid, p_kind text, p_target_child_id uuid default null,
  p_can_write boolean default true, p_ttl_hours int default 168)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_acad public.groups%rowtype; v_code text; v_hash text; v_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if; -- belt-and-suspenders
  select * into v_acad from public.groups where id = p_academy_id and purpose = 'academy';
  if v_acad.id is null or v_acad.created_by <> v_uid then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_kind not in ('enrolled_parent', 'tutor', 'coach') then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  if p_kind in ('tutor', 'coach') and p_target_child_id is null then return jsonb_build_object('ok', false, 'error', 'target_required'); end if;
  -- random 64-hex bearer code; store ONLY its sha256
  v_code := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_hash := encode(extensions.digest(convert_to(v_code, 'utf8'), 'sha256'), 'hex');
  insert into public.invitations (code_hash, kind, academy_id, target_child_id, can_write, created_by, expires_at)
    values (v_hash, p_kind, p_academy_id, p_target_child_id, coalesce(p_can_write, true), v_uid,
            now() + make_interval(hours => greatest(1, coalesce(p_ttl_hours, 168))))
    returning id into v_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'invitation.mint', p_target_child_id, 'allow',
            jsonb_build_object('invitation_id', v_id, 'kind', p_kind, 'academy_id', p_academy_id));
  return jsonb_build_object('ok', true, 'invitation_id', v_id, 'code', v_code);  -- plaintext returned ONCE
end $$;
revoke all on function public.mint_invitation(uuid, text, uuid, boolean, int) from public, anon;
grant execute on function public.mint_invitation(uuid, text, uuid, boolean, int) to authenticated;

-- redeem_invitation — a signed-in adult exchanges a key for their Academy-scoped
-- role. Fail-closed: any invalid/expired/used key returns a GENERIC error (no
-- oracle) and confers NOTHING.
create or replace function public.redeem_invitation(p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_hash text; v_inv public.invitations%rowtype;
        v_child public.children%rowtype; v_gid uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  -- a child login can never redeem (Academy trust never comes from a child actor)
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_code is null or length(btrim(p_code)) < 8 then return jsonb_build_object('ok', false, 'error', 'invalid_or_used'); end if;
  v_hash := encode(extensions.digest(convert_to(btrim(p_code), 'utf8'), 'sha256'), 'hex');
  -- lock the row: pending + unexpired only; single generic error for everything else
  select * into v_inv from public.invitations
    where code_hash = v_hash and status = 'pending' and expires_at > now()
    for update;
  if v_inv.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_used'); end if;

  if v_inv.kind = 'enrolled_parent' then
    -- enrollment IS the consent: the parent's ACADEMY family (arena=academy) linked
    -- to the Academy (org_id), + a guardian membership + an Academy membership.
    select id into v_gid from public.groups
      where created_by = v_uid and purpose = 'family' and arena = 'academy' and org_id = v_inv.academy_id
      order by created_at limit 1;
    if v_gid is null then
      insert into public.groups (purpose, name, arena, org_id, created_by)
        values ('family', 'My family', 'academy', v_inv.academy_id, v_uid) returning id into v_gid;
      insert into public.memberships (group_id, member_actor_id, role, active)
        values (v_gid, v_uid, 'guardian', true);
    end if;
    if not exists (select 1 from public.memberships where group_id = v_inv.academy_id and member_actor_id = v_uid) then
      insert into public.memberships (group_id, member_actor_id, role, active)
        values (v_inv.academy_id, v_uid, 'parent', true);
    else
      update public.memberships set active = true where group_id = v_inv.academy_id and member_actor_id = v_uid;
    end if;

  else  -- 'tutor' | 'coach'
    select * into v_child from public.children where id = v_inv.target_child_id;
    if v_child.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_used'); end if;
    -- enrollment-is-consent REQUIRES the child to be enrolled in THIS Academy
    if not exists (select 1 from public.groups g
                   where g.created_by = v_child.parent_id and g.purpose = 'family'
                     and g.arena = 'academy' and g.org_id = v_inv.academy_id) then
      return jsonb_build_object('ok', false, 'error', 'child_not_enrolled');
    end if;
    -- respect a parent's REVOCATION: the Academy cannot silently re-grant a tutor the
    -- parent removed (the parent holds revocation at any time — ratified model). A
    -- parent-revoked grant blocks redemption (coordinate with the parent out-of-band);
    -- an active grant is refreshed idempotently; a fresh one is inserted.
    if exists (select 1 from public.tutor_grants where tutor_id = v_uid and child_id = v_child.id and not active) then
      return jsonb_build_object('ok', false, 'error', 'revoked_by_parent');
    end if;
    -- SCOPED grant to EXACTLY this child; granted_by = the enrolled parent so the
    -- parent sees who has access (transparency) with no RLS recursion.
    insert into public.tutor_grants (tutor_id, child_id, granted_by, can_write, active)
      values (v_uid, v_child.id, v_child.parent_id, coalesce(v_inv.can_write, true), true)
      on conflict (tutor_id, child_id) do update set can_write = excluded.can_write;
    -- staff membership in the Academy
    if not exists (select 1 from public.memberships where group_id = v_inv.academy_id and member_actor_id = v_uid) then
      insert into public.memberships (group_id, member_actor_id, role, active)
        values (v_inv.academy_id, v_uid, v_inv.kind, true);
    else
      update public.memberships set active = true, role = v_inv.kind where group_id = v_inv.academy_id and member_actor_id = v_uid;
    end if;
  end if;

  -- one-time: burn the key
  update public.invitations set status = 'redeemed', redeemed_at = now(), redeemed_by = v_uid where id = v_inv.id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'invitation.redeem', v_inv.target_child_id, 'allow',
            jsonb_build_object('invitation_id', v_inv.id, 'kind', v_inv.kind, 'academy_id', v_inv.academy_id, 'subject', public.stable_subject(v_uid)));
  return jsonb_build_object('ok', true, 'kind', v_inv.kind);
end $$;
revoke all on function public.redeem_invitation(text) from public, anon;
grant execute on function public.redeem_invitation(text) to authenticated;
