-- ============================================================================
-- 0044_grant_provenance.sql — Phase 5 · Group Engine · S5a. GRANT-TABLE PREP.
-- Give tutor_grants a PROVENANCE so a group-derived (auto, ref-counted) grant can
-- coexist with a parent-hand-issued grant for the same tutor+child WITHOUT collision
-- or overwrite. This slice ONLY prepares the table — S5b does the minting/revoking.
--
-- can_view_child (0001:340-349) and can_write_child (0004:35-45) are NOT TOUCHED — they
-- stay "is_my_child OR EXISTS(active grant [AND can_write])", which is exactly the
-- monotone ref-count (access while ANY active grant of any origin remains). is_group_member
-- and the S3/S4 policies are unchanged. role stays on the grant.
--
-- Every EXISTING row defaults to origin='parent_direct', origin_group_id NULL → behaves
-- byte-for-byte as today (one parent grant per tutor+child; readers see it unchanged).
-- Verified by a 9-agent adversarial sweep: collision impossible (two DISJOINT partial
-- indexes + the group_derived-IFF-group CHECK closes the NULL hole), existing grants
-- unchanged, purge covers both origins. Forward-only. DEV/local only. SEC-03 before apply.
-- ============================================================================

-- ---- provenance columns + the invariant that makes the group_derived index total ----
alter table public.tutor_grants add column origin text not null default 'parent_direct'
  check (origin in ('parent_direct','group_derived'));
alter table public.tutor_grants add column origin_group_id uuid references public.groups(id) on delete cascade;
-- group_derived IFF a group is named. This biconditional over two never-NULL booleans hard-rejects
-- a group_derived row with NULL origin_group_id — closing the only NULL-distinct hole in index #2.
alter table public.tutor_grants add constraint tutor_grants_origin_group_ck
  check ((origin = 'group_derived') = (origin_group_id is not null));

-- ---- swap the single unique key for two DISJOINT partial unique indexes ----
-- parent_direct: at most ONE hand-issued grant per (tutor, child).
-- group_derived: at most ONE auto grant per (tutor, child, group) — multiplicity IS the ref-count.
-- The predicates partition the table, so a group_derived row can never collide with a parent_direct one.
alter table public.tutor_grants drop constraint tutor_grants_tutor_id_child_id_key;
create unique index tutor_grants_parent_direct_uniq
  on public.tutor_grants (tutor_id, child_id) where origin = 'parent_direct';
create unique index tutor_grants_group_derived_uniq
  on public.tutor_grants (tutor_id, child_id, origin_group_id) where origin = 'group_derived';

-- ---- (7) close the client forge: clients may only ever insert a parent_direct grant ----
-- The insert RLS only checked granted_by/is_my_child; without this a parent could client-insert
-- origin='group_derived' with an arbitrary (unverified) origin_group_id and forge a ref-counted
-- grant S5b would honor. group_derived rows now come ONLY from the server-side / SECURITY DEFINER
-- mint path (S5b) or service_role. Behavior-preserving: a legitimate client insert omits origin,
-- so the DEFAULT 'parent_direct' satisfies the added check.
drop policy tutor_grants_insert on public.tutor_grants;
create policy tutor_grants_insert on public.tutor_grants
  for insert to authenticated
  with check (granted_by = auth.uid() and public.is_my_child(child_id) and origin = 'parent_direct');
-- Symmetric closure: clients may only ever manage (revoke/re-issue) their OWN parent_direct grants.
-- group_derived grants are SYSTEM-managed (minted + revoked on membership-end by S5b's server path),
-- so a parent must NOT be able to client-side re-activate a system-revoked class grant. Behavior-
-- preserving today (every existing grant is parent_direct). The (active, revoked_at) column grant
-- (0001:449) already blocks mutating origin; this scopes WHICH rows a client can touch at all.
drop policy tutor_grants_update on public.tutor_grants;
create policy tutor_grants_update on public.tutor_grants
  for update to authenticated
  using (granted_by = auth.uid() and origin = 'parent_direct')
  with check (granted_by = auth.uid() and origin = 'parent_direct');

-- ---- (8)+(9) redeem_invitation: retarget the upsert arbiter to the parent_direct partial index,
-- and scope its parent-revocation guard to parent_direct (else an inactive GROUP-derived grant —
-- a child who left a class — would masquerade as a parent revocation and block a legit invitation).
-- Byte-for-byte identical to 0023 otherwise; both changes are no-ops on today's all-parent_direct data.
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
    -- respect a parent's REVOCATION (S5a: PARENT_DIRECT only — a group-derived grant left inactive
    -- by leaving a class is NOT a parent revocation and must not block a legitimate direct invitation).
    if exists (select 1 from public.tutor_grants where tutor_id = v_uid and child_id = v_child.id and origin = 'parent_direct' and not active) then
      return jsonb_build_object('ok', false, 'error', 'revoked_by_parent');
    end if;
    -- SCOPED parent_direct grant to EXACTLY this child; granted_by = the enrolled parent so the
    -- parent sees who has access (transparency) with no RLS recursion.
    insert into public.tutor_grants (tutor_id, child_id, granted_by, can_write, active)
      values (v_uid, v_child.id, v_child.parent_id, coalesce(v_inv.can_write, true), true)
      on conflict (tutor_id, child_id) where origin = 'parent_direct' do update set can_write = excluded.can_write;
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
