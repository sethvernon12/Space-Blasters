-- ============================================================================
-- 0048_academy_class_provision.sql — Phase 5 · Group Engine · S8. THE ACADEMY REDEEM
-- REFACTOR. Retire the bespoke per-child parent_direct academy-tutor grant and assemble
-- class/team GROUPS via the engine instead — so the roster (is_group_leader, S7) and the
-- WORK-grants (S5b reconcile_group_grant) DERIVE automatically, and academy-tutor work-
-- access finally routes through the background-check gate (D1: is_leader_verified =
-- is_academy_staff = academy staff membership AND completed background check).
--
-- SECURITY WIN (D1): today redeem_invitation mints a parent_direct grant with NO background
-- check (is_academy_staff is never consulted). Under S8 the co-mint is bg-check-gated, so in
-- DEV (no clearance rows) an academy tutor gets ROSTER-ONLY, no work, until the launch-gate
-- clearance is wired — consistent with "unverified leader → roster only."
--
-- can_view_child / can_write_child / is_group_member / is_group_leader are UNCHANGED. The
-- consent kernel + enrollment-is-consent (LEG-02) predicate is UNCHANGED — the same is_enrolled
-- predicate that today authorizes the grant now authorizes the class membership. But NOTE the
-- effective WORK-access gating is TIGHTENED, not merely preserved: 0044's bespoke parent_direct
-- grant was minted on enrollment ALONE (no consent_id, no background check). Under S8 the class
-- membership is enrollment-authorized, but the WORK-grant flows only through reconcile_group_grant,
-- which additionally requires consent_id (drain HELD + reconcile) AND a verified leader (D1). Do
-- NOT "restore" the old un-gated parent_direct mint believing it equivalent — it was weaker.
-- reconcile_group_grant / drain_derivations / join_group / leave_group are UNCHANGED (reused).
-- role stays on the grant. Deletion covenant intact (NO new tables; the class group is the
-- tutor's, not child-keyed; a child's memberships + group_derived grants already purge).
-- Forward-only. DEV/local only. SEC-03: 3 independent adversarial reviews PASS (no BLOCKER);
-- SF-1 (parent_direct revocation guard) + SF-2 (bind-once unique index) folded below.
-- ============================================================================

-- ---- (SF-2) bind-once needs a BACKING unique index (else the SELECT-then-INSERT is TOCTOU) ----
-- Two concurrent redeems by the same tutor (different keys → the invitation FOR UPDATE lock does not
-- serialize them) could both read no class and both INSERT → two classes for one (academy, tutor,
-- purpose), splitting the roster and letting a ghost duplicate survive a parent's remove-from-class.
-- Mirrors groups_family_arena_uniq (0022): make the idempotency key a real constraint. Partial so it
-- covers ONLY academy-scoped class/team groups (standalone create_group classes carry org_id NULL).
create unique index groups_academy_class_uniq
  on public.groups (org_id, created_by, purpose)
  where org_id is not null and purpose in ('class','team');

-- ---- (a) provision_academy_class — the INTERNAL, idempotent class/team provisioner --------
-- NOT the public create_group RPC: create_group hardwires org_id=NULL (standalone) so its
-- classes would take the standalone id-verification branch of is_leader_verified. An academy
-- class MUST carry org_id=academy so is_leader_verified takes the ACADEMY branch (is_academy_
-- staff). Idempotent bind-once per (academy, leader, purpose): the stable lookup returns an
-- existing class so a re-redeem never double-provisions. created_by = the redeeming leader
-- (D-choice below); the leader membership is written through join_group (the same outbox path
-- every membership uses — mirrors create_group), so is_group_leader holds and the S7 roster
-- lights up. Definer, internal-only (revoked from authenticated): reachable solely from
-- redeem_invitation, itself gated by an academy-minted key.
create or replace function public.provision_academy_class(p_academy uuid, p_leader uuid, p_purpose text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_gid uuid; v_role text; v_name text;
begin
  if p_academy is null or p_leader is null then return null; end if;
  if p_purpose not in ('class','team') then return null; end if;
  if public.actor_is_deleted(p_leader) then return null; end if;   -- zombie-write guard (parity with create_group)
  v_role := case p_purpose when 'class' then 'tutor' when 'team' then 'coach' end;

  -- idempotent bind-once: one class/team per (academy, leader, purpose) — re-redeem reuses it.
  select id into v_gid from public.groups
   where org_id = p_academy and created_by = p_leader and purpose = p_purpose::public.group_purpose
   limit 1;
  if v_gid is not null then return v_gid; end if;

  select left(coalesce(name, 'Academy'), 100) into v_name from public.groups where id = p_academy;
  begin
    insert into public.groups (purpose, name, org_id, created_by)
      values (p_purpose::public.group_purpose,
              coalesce(v_name, 'Academy') || (case p_purpose when 'class' then ' — Class' else ' — Team' end),
              p_academy, p_leader)
      returning id into v_gid;
  exception when unique_violation then
    -- (SF-2) a concurrent redeem won the bind-once race; reuse ITS class (the winner binds the
    -- leader membership). Return without a second join_group — bind-once holds.
    select id into v_gid from public.groups
     where org_id = p_academy and created_by = p_leader and purpose = p_purpose::public.group_purpose
     limit 1;
    return v_gid;
  end;
  -- leader membership through the transactional outbox path (join_group authorizes on
  -- created_by = auth.uid() = the redeeming leader; mirrors create_group exactly).
  perform public.join_group(v_gid, null, p_leader, v_role);
  return v_gid;
end $$;
revoke all on function public.provision_academy_class(uuid, uuid, text) from public, anon, authenticated;

-- ---- (c) academy_enroll_class_child — the ENROLLMENT-AUTHORIZED child add (the new lane) ---
-- THE CRUX: a leader calling join_group for an enrolled child is rejected by the C1 border
-- (can_write_child, which the leader lacks pre-grant — the chicken-and-egg). So the child-add
-- is a definer path authorized by ENROLLMENT: it re-checks the EXACT is_enrolled predicate
-- redeem_invitation already uses (enrollment IS consent, LEG-02) in place of can_write_child,
-- then writes membership + event + outbox IDENTICALLY to join_group. The drain then co-mints
-- the group_derived work-grant IFF is_leader_verified (S5b, unchanged). This is the same
-- enrollment=consent substitution today's parent_direct grant already makes, now expressed as
-- a membership. CAREFUL-OUT: it never silently re-adds a child a parent/academy REMOVED (an
-- inactive membership) — re-add is the parent's explicit action (S6 parent-supreme). Definer,
-- internal-only (revoked from authenticated): reachable solely from redeem_invitation.
create or replace function public.academy_enroll_class_child(p_class uuid, p_child uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_class public.groups%rowtype; v_child public.children%rowtype;
        v_mid uuid; v_active boolean; v_event_id uuid;
begin
  select * into v_class from public.groups where id = p_class;
  if v_class.id is null or v_class.purpose not in ('class','team') or v_class.org_id is null then
    return jsonb_build_object('ok', false, 'error', 'bad_group');
  end if;
  select * into v_child from public.children where id = p_child;
  if v_child.id is null or v_child.parent_id is null then
    return jsonb_build_object('ok', false, 'error', 'bad_child');
  end if;

  -- ENROLLMENT-AUTHORIZED (the new lane): the child's own parent enrolled them in THIS academy
  -- (arena='academy' family linked by org_id) — enrollment IS the consent. This SUBSTITUTES for
  -- can_write_child, which the leader lacks pre-grant; it is the SAME predicate redeem uses.
  if not exists (select 1 from public.groups g
                 where g.created_by = v_child.parent_id and g.purpose = 'family'
                   and g.arena = 'academy' and g.org_id = v_class.org_id) then
    return jsonb_build_object('ok', false, 'error', 'child_not_enrolled');
  end if;

  -- careful-out: never silently re-add a child a parent/academy REMOVED (S6). An active
  -- membership → idempotent no-op; an INACTIVE one → refuse (re-add is the parent's explicit act).
  select id, active into v_mid, v_active from public.memberships
   where group_id = p_class and member_child_id = p_child and member_actor_id is null;
  if v_mid is not null and v_active then
    return jsonb_build_object('ok', true, 'already', true);
  elsif v_mid is not null and not v_active then
    return jsonb_build_object('ok', false, 'error', 'removed_from_class');
  end if;

  -- fresh membership + event + outbox — IDENTICAL to join_group's write block; the drain co-mints.
  insert into public.memberships (group_id, member_child_id, member_actor_id, role, active)
    values (p_class, p_child, null, 'member', true) returning id into v_mid;
  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
    values ('membership', v_child.parent_id, p_child, p_class,
            jsonb_build_object('action', 'join', 'role', 'member', 'membership_id', v_mid, 'via', 'academy_enrollment'))
    returning id into v_event_id;
  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
    values (v_event_id, 'join', p_class, p_child, null, 'member',
            'join:' || v_mid::text || ':' || v_event_id::text, 'pending');
  return jsonb_build_object('ok', true, 'membership_id', v_mid, 'event_id', v_event_id);
end $$;
revoke all on function public.academy_enroll_class_child(uuid, uuid) from public, anon, authenticated;

-- ---- redeem_invitation — S8: the tutor/coach branch assembles a class GROUP via the engine --
-- Identical to 0044 EXCEPT the tutor/coach branch: the bespoke parent_direct grant insert is
-- replaced by provision-once the class + enrollment-authorized child add (→ drain co-mints the
-- group_derived grant IFF verified). The enrolled_parent branch is BYTE-IDENTICAL to 0044. The
-- academy staff membership is UNCHANGED (it is what makes is_academy_staff → is_leader_verified
-- true once the background check is cleared). The parent-revocation guard is RE-EXPRESSED (D2):
-- a child the parent/academy removed from the class is an inactive membership → academy_enroll_
-- class_child returns 'removed_from_class' and redeem returns early WITHOUT burning the key (as
-- the old 'revoked_by_parent' path did) — re-add is the parent's explicit S6 action.
create or replace function public.redeem_invitation(p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_hash text; v_inv public.invitations%rowtype;
        v_child public.children%rowtype; v_gid uuid; v_class uuid; v_enroll jsonb;
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
    -- to the Academy (org_id), + a guardian membership + an Academy membership. (UNCHANGED from 0044.)
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
    if public.actor_is_deleted(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if; -- zombie-write guard
    select * into v_child from public.children where id = v_inv.target_child_id;
    if v_child.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_used'); end if;
    -- enrollment-is-consent REQUIRES the child enrolled in THIS Academy (UNCHANGED predicate)
    if not exists (select 1 from public.groups g
                   where g.created_by = v_child.parent_id and g.purpose = 'family'
                     and g.arena = 'academy' and g.org_id = v_inv.academy_id) then
      return jsonb_build_object('ok', false, 'error', 'child_not_enrolled');
    end if;
    -- (SF-1) respect a parent's REVOCATION (parent_direct only): if the child's own parent revoked a
    -- DIRECT grant to this tutor, an Academy re-mint must NOT silently re-grant (parent-supreme careful-
    -- out). A group_derived grant left inactive by leaving a class is handled by the membership guard in
    -- academy_enroll_class_child, so scope this to parent_direct (matches 0044:110). Returns BEFORE any
    -- write (no partial commit). The parent re-permits by reactivating their own parent_direct grant.
    if exists (select 1 from public.tutor_grants
               where tutor_id = v_uid and child_id = v_child.id and origin = 'parent_direct' and not active) then
      return jsonb_build_object('ok', false, 'error', 'revoked_by_parent');
    end if;

    -- staff membership in the Academy FIRST (what makes is_academy_staff → is_leader_verified true
    -- once the background check is cleared; UNCHANGED from 0044 otherwise).
    if not exists (select 1 from public.memberships where group_id = v_inv.academy_id and member_actor_id = v_uid) then
      insert into public.memberships (group_id, member_actor_id, role, active)
        values (v_inv.academy_id, v_uid, v_inv.kind, true);
    else
      update public.memberships set active = true, role = v_inv.kind where group_id = v_inv.academy_id and member_actor_id = v_uid;
    end if;

    -- S8: assemble via the engine (REPLACES the bespoke parent_direct grant).
    -- (a) provision-once the academy class/team led by this tutor/coach (idempotent, org_id=academy)
    v_class := public.provision_academy_class(v_inv.academy_id, v_uid,
                 case v_inv.kind when 'tutor' then 'class' when 'coach' then 'team' end);
    if v_class is null then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
    -- (c) enrollment-authorized child add → membership → the drain co-mints the group_derived grant
    -- IFF verified. Careful-out: a parent-removed child is NOT silently re-added (return WITHOUT burning).
    v_enroll := public.academy_enroll_class_child(v_class, v_child.id);
    if not (v_enroll->>'ok')::boolean then
      return v_enroll;  -- 'removed_from_class' / 'child_not_enrolled' — respect careful-out; key stays pending
    end if;
  end if;

  -- one-time: burn the key
  update public.invitations set status = 'redeemed', redeemed_at = now(), redeemed_by = v_uid where id = v_inv.id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'invitation.redeem', v_inv.target_child_id, 'allow',
            jsonb_build_object('invitation_id', v_inv.id, 'kind', v_inv.kind, 'academy_id', v_inv.academy_id,
                               'class_id', v_class, 'subject', public.stable_subject(v_uid)));
  return jsonb_build_object('ok', true, 'kind', v_inv.kind, 'class_id', v_class);
end $$;
revoke all on function public.redeem_invitation(text) from public, anon;
grant execute on function public.redeem_invitation(text) to authenticated;
