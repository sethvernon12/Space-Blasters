-- ============================================================================
-- 0045_group_grant_reconcile.sql — Phase 5 · Group Engine · S5b. THE WORK-GRANT
-- BRIDGE. A group's VERIFIED leader gains the WORK view (can_view_child) when a
-- parent-authorized ACTIVE membership lands, and loses it (audited) when the last
-- justifying membership ends. Realized as a RECONCILED PROJECTION of membership
-- truth — never an event-delta — so it is order-insensitive, convergent, self-healing
-- under the unordered/concurrent drain (the leave/rejoin race a naive mint-on-join/
-- revoke-on-leave would have had).
--
-- reconcile_group_grant(group, child): sets each group_derived tutor_grant's active =
--   (an active membership of that child in that group EXISTS) AND child consented AND
--   the child has a parent AND the leader is VERIFIED. Mints/reactivates for verified
--   leaders; revokes existing rows for de-verified/ex-leaders or ended memberships.
--   Every false<->true transition writes an EXPLICIT, provenance-complete consent_ledger
--   + audit_log row (HARD RULE #7; the AFTER-INSERT disclosure trigger does NOT fire on
--   the reactivation UPDATE, and is disabled for group_derived here — the reconcile owns
--   group_derived logging). NULL-parent is skipped (no granted_by → no poison-pill).
--
-- Called by: the drain (0008 join/leave branches — async convergence + the join co-mint),
--   leave_group (SYNCHRONOUS careful-out cut), and re-driver triggers on consent-grant +
--   clearance-change (retroactive mint for a consented-after-join child / verified-after-
--   join leader). can_view_child / can_write_child / is_group_member UNCHANGED. role stays
--   on the grant. Forward-only. DEV/local only. MUST be SEC-03'd before any apply.
-- ============================================================================

-- ---- standalone-leader ID-verification clearance (deny-by-default; pre-real-families gate) ----
-- Mirrors academy_staff_clearances (0042): a real FORCE-RLS table + a definer predicate that is
-- FALSE by construction with no rows — never a nullable column that defaults open. The Academy's
-- academy staff gate on is_academy_staff (completed background check); an INDEPENDENT standalone
-- class/team leader who reaches other families' children gates on this ID-verification clearance.
-- No rows are written in DEV: the standalone-leader identity-proof process is a PRE-REAL-FAMILIES
-- LAUNCH GATE ("standalone leader identity-verified"). Until it exists, standalone leaders get NO
-- group_derived work-grant (roster only) — the split-gate parent-confirm still governs participation.
create table public.standalone_leader_clearances (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null,
  check_kind   text not null default 'id_verification',
  completed_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (actor_id, check_kind)
);
alter table public.standalone_leader_clearances enable row level security;
alter table public.standalone_leader_clearances force  row level security;
revoke all on public.standalone_leader_clearances from public, anon, authenticated;  -- deny-by-default; definer-read only

create or replace function public.has_standalone_leader_verification(p_actor uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.standalone_leader_clearances c
    where c.actor_id = p_actor and c.check_kind = 'id_verification'
      and c.completed_at is not null and c.revoked_at is null)
$$;
revoke all on function public.has_standalone_leader_verification(uuid) from public, anon;
grant execute on function public.has_standalone_leader_verification(uuid) to authenticated;

-- ---- is_leader_verified — the mint gate (academy staff OR standalone id-verified) ----
create or replace function public.is_leader_verified(p_leader uuid, p_group_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when (select org_id from public.groups where id = p_group_id) is not null
      then public.is_academy_staff((select org_id from public.groups where id = p_group_id), p_leader)
    else public.has_standalone_leader_verification(p_leader)
  end
$$;
revoke all on function public.is_leader_verified(uuid, uuid) from public, anon;
grant execute on function public.is_leader_verified(uuid, uuid) to authenticated;

-- ---- log_group_grant_ledger — the EXPLICIT provenance-complete audit for a group_derived transition
create or replace function public.log_group_grant_ledger(p_tutor uuid, p_child uuid, p_parent uuid, p_group uuid, p_event text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  -- consent_ledger (append-only; parent_id NOT NULL — caller guarantees p_parent is non-null)
  insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
  values (p_parent, p_child,
          case when p_event = 'revoke' then 'revoke' else 'disclosure' end,
          'parent_authorization', 'disclosure-v1',
          jsonb_build_object('grantee_id', p_tutor, 'origin', 'group_derived', 'origin_group_id', p_group, 'event', p_event));
  -- audit_log (actor = the authorizing parent, so the parent sees the grant lifecycle in their audit)
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (p_parent, 'group_grant.' || p_event, p_child, 'allow',
          jsonb_build_object('grantee_id', p_tutor, 'origin', 'group_derived', 'origin_group_id', p_group));
end $$;
revoke all on function public.log_group_grant_ledger(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

-- ---- reconcile_group_grant — THE CORE: reconcile-to-truth for one (group, child) ----
create or replace function public.reconcile_group_grant(p_group_id uuid, p_child_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_group  public.groups%rowtype;
  v_child  public.children%rowtype;
  v_should boolean;
  v_target uuid[];
  v_leader uuid;
  v_was    boolean;
  v_grant  public.tutor_grants%rowtype;
begin
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null or v_group.purpose not in ('class','team') then return; end if;  -- S5b: class/team only
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then return; end if;

  -- reconcile-to-truth precondition: a CURRENT active membership AND consent AND a parent to attribute to.
  -- NULL parent_id → skip mint (cannot set granted_by/ledger.parent_id) and revoke any existing (poison-pill guard).
  v_should := exists (select 1 from public.memberships m
                      where m.group_id = p_group_id and m.member_child_id = p_child_id and m.active)
              and v_child.consent_id is not null
              and v_child.parent_id is not null;

  -- the VERIFIED leaders who SHOULD hold a grant (empty when not should)
  if v_should then
    select coalesce(array_agg(x.L), '{}'::uuid[]) into v_target
    from (
      select v_group.created_by as L
      union
      select m.member_actor_id from public.memberships m
       where m.group_id = p_group_id and m.member_child_id is null and m.active
         and m.role = (case v_group.purpose when 'class' then 'tutor' when 'team' then 'coach' end)
    ) x
    where x.L is not null and public.is_leader_verified(x.L, p_group_id);
  else
    v_target := '{}'::uuid[];
  end if;

  -- MINT / REACTIVATE for each target leader; explicit disclosure ledger on a false->true transition.
  foreach v_leader in array v_target loop
    select active into v_was from public.tutor_grants
     where tutor_id = v_leader and child_id = p_child_id and origin = 'group_derived' and origin_group_id = p_group_id;
    insert into public.tutor_grants (tutor_id, child_id, granted_by, role, can_write, origin, origin_group_id, active)
    values (v_leader, p_child_id, v_child.parent_id, 'tutor', true, 'group_derived', p_group_id, true)
    on conflict (tutor_id, child_id, origin_group_id) where origin = 'group_derived'
    do update set active = true, revoked_at = null;
    if v_was is distinct from true then                       -- new insert OR reactivation (false/null -> true)
      perform public.log_group_grant_ledger(v_leader, p_child_id, v_child.parent_id, p_group_id, 'disclosure');
    end if;
  end loop;

  -- REVOKE existing group_derived rows whose leader is NOT a current target (membership ended,
  -- leader de-verified, or ex-leader). Iterates EXISTING ROWS by origin_group_id (never a recomputed
  -- "current leaders" set) so a de-verified leader is still revoked. Explicit revoke ledger per transition.
  for v_grant in
    select * from public.tutor_grants
     where child_id = p_child_id and origin = 'group_derived' and origin_group_id = p_group_id
       and active and not (tutor_id = any (v_target))
  loop
    update public.tutor_grants set active = false, revoked_at = now() where id = v_grant.id;
    perform public.log_group_grant_ledger(v_grant.tutor_id, p_child_id, v_grant.granted_by, p_group_id, 'revoke');
  end loop;
end $$;
revoke all on function public.reconcile_group_grant(uuid, uuid) from public, anon, authenticated;  -- server/definer callers only

-- ---- redrive_leader_grants — reconcile every child in every class/team a leader leads ----
create or replace function public.redrive_leader_grants(p_leader uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_g uuid; v_c uuid;
begin
  for v_g in
    select g.id from public.groups g
     where g.purpose in ('class','team')
       and (g.created_by = p_leader
            or exists (select 1 from public.memberships m
                        where m.group_id = g.id and m.member_actor_id = p_leader and m.member_child_id is null and m.active
                          and m.role = (case g.purpose when 'class' then 'tutor' when 'team' then 'coach' end)))
  loop
    for v_c in
      select member_child_id from public.memberships where group_id = v_g and member_child_id is not null and active
      union
      select child_id from public.tutor_grants where tutor_id = p_leader and origin = 'group_derived' and origin_group_id = v_g
    loop
      perform public.reconcile_group_grant(v_g, v_c);
    end loop;
  end loop;
end $$;
revoke all on function public.redrive_leader_grants(uuid) from public, anon, authenticated;

-- ---- RE-DRIVER TRIGGERS: retroactively mint on consent-grant + clearance-change (fail-closed until fired)
-- consent lands (children.consent_id NULL -> set): reconcile the child's class/team memberships.
create or replace function public.redrive_on_consent() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- symmetric: any consent_id change (grant NULL->set OR a future soft-revoke set->NULL) reconciles;
  -- reconcile keys should-active on consent_id IS NOT NULL, so a revoke reconciles to inactive.
  if old.consent_id is distinct from new.consent_id then
    perform public.reconcile_group_grant(m.group_id, new.id)
      from public.memberships m join public.groups g on g.id = m.group_id
     where m.member_child_id = new.id and m.active and g.purpose in ('class','team');
  end if;
  return new;
end $$;
revoke all on function public.redrive_on_consent() from public, anon, authenticated;
create trigger children_consent_redrive after update of consent_id on public.children
  for each row execute function public.redrive_on_consent();

-- clearance change (academy OR standalone; grant OR revoke of verification): reconcile that leader's groups.
create or replace function public.redrive_on_clearance() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.redrive_leader_grants(coalesce(new.actor_id, old.actor_id));
  return null;
end $$;
revoke all on function public.redrive_on_clearance() from public, anon, authenticated;
create trigger academy_clearance_redrive after insert or update on public.academy_staff_clearances
  for each row execute function public.redrive_on_clearance();
create trigger standalone_clearance_redrive after insert or update on public.standalone_leader_clearances
  for each row execute function public.redrive_on_clearance();

-- SHOULD-FIX 1: an ADULT membership change re-drives that leader's grants. is_leader_verified for an
-- academy group depends on is_academy_staff = (active academy tutor/coach membership) AND (background
-- check). The clearance side is re-driven above; this closes the OTHER input — removing a tutor from the
-- academy (or a role downgrade) must re-project verification onto their class/team work-grants, else a
-- removed adult's grant would linger active. Child (member_child_id) rows are the drain's job → skipped here.
create or replace function public.redrive_on_adult_membership() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := coalesce(new.member_actor_id, old.member_actor_id);
begin
  if v_actor is not null then
    perform public.redrive_leader_grants(v_actor);
  end if;
  return null;
end $$;
revoke all on function public.redrive_on_adult_membership() from public, anon, authenticated;
create trigger memberships_adult_redrive after insert or update or delete on public.memberships
  for each row execute function public.redrive_on_adult_membership();

-- ---- log_tutor_disclosure: skip group_derived (the reconcile owns provenance-complete group_derived logging) ----
create or replace function public.log_tutor_disclosure() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  -- parent_direct grants: the parent disclosed this child's data to the grantee (unchanged 0004 behavior).
  -- group_derived grants are logged EXPLICITLY + provenance-complete by reconcile_group_grant (S5b), so skip
  -- them here to avoid a double, provenance-blind ledger row.
  if new.origin = 'parent_direct' then
    insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
    values (new.granted_by, new.child_id, 'disclosure', 'parent_authorization', 'disclosure-v1',
            jsonb_build_object('grantee_id', new.tutor_id, 'grant_id', new.id,
                               'role', new.role, 'domain', new.domain, 'can_write', new.can_write, 'origin', new.origin));
  end if;
  return new;
end $$;

-- ---- leave_group: SYNCHRONOUS careful-out cut (immediate revoke), audited by the reconcile ----
-- Identical to 0008 except the S5b synchronous reconcile after the membership flip: for a class/team,
-- reconcile the affected (child) — or every child a leaving leader had — so the group_derived work-grant
-- is cut the INSTANT the membership ends (no drain lag in the careful-out direction), with the ledger/audit
-- written by the reconcile. The drain's 'leave' processing reconciles again (idempotent) for convergence.
create or replace function public.leave_group(p_group_id uuid, p_member_child_id uuid, p_member_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_role text;
  v_event_id uuid;
  v_cid uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  if not (v_group.created_by = v_uid
          or (p_member_child_id is not null and public.is_my_child(p_member_child_id))) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id, role into v_membership_id, v_role from public.memberships
   where group_id = p_group_id
     and member_child_id is not distinct from p_member_child_id
     and member_actor_id is not distinct from p_member_actor_id and active;
  if v_membership_id is null then return jsonb_build_object('ok', false, 'error', 'not_a_member'); end if;

  update public.memberships set active = false, left_at = now() where id = v_membership_id;
  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('membership', v_uid, p_member_child_id, p_group_id,
          jsonb_build_object('action', 'leave', 'membership_id', v_membership_id))
  returning id into v_event_id;
  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
  values (v_event_id, 'leave', p_group_id, p_member_child_id, p_member_actor_id, coalesce(v_role, 'member'),
          'leave:' || v_membership_id::text || ':' || v_event_id::text, 'pending');

  -- S5b SYNCHRONOUS CUT: reconcile the affected group_derived work-grants NOW (the membership is already
  -- inactive above → should-active=false → immediate revoke + audited ledger). Idempotent with the drain.
  if v_group.purpose in ('class','team') then
    if p_member_child_id is not null then
      perform public.reconcile_group_grant(p_group_id, p_member_child_id);
    elsif p_member_actor_id is not null then
      for v_cid in
        select member_child_id from public.memberships where group_id = p_group_id and member_child_id is not null and active
        union
        select child_id from public.tutor_grants where tutor_id = p_member_actor_id and origin = 'group_derived' and origin_group_id = p_group_id
      loop
        perform public.reconcile_group_grant(p_group_id, v_cid);
      end loop;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;
revoke all on function public.leave_group(uuid, uuid, uuid) from public, anon;
grant execute on function public.leave_group(uuid, uuid, uuid) to authenticated;

-- ---- drain_derivations: add the reconcile dispatch (async convergence + the join co-mint) ----
-- Identical to 0008 except the S5b reconcile call after the join/leave branch (before the per-item audit):
-- a child event reconciles (group, child); a leader/adult event reconciles every active-or-granted child in
-- the group (mint for a new leader, revoke for a leaving one). Reconcile-to-truth is order-insensitive, so
-- co-mint/revoke converge regardless of the unordered outbox.
create or replace function public.drain_derivations() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.derivation_outbox%rowtype;
  v_group public.groups%rowtype;
  v_rule public.derivation_rules%rowtype;
  v_channel_id uuid;
  v_cid uuid;
  v_processed int := 0; v_held int := 0; v_reversed int := 0;
begin
  for v_row in select * from public.derivation_outbox where status = 'pending' for update skip locked loop
    select * into v_group from public.groups where id = v_row.group_id;

    if v_row.member_child_id is not null
       and not exists (select 1 from public.children where id = v_row.member_child_id and consent_id is not null) then
      update public.derivation_outbox set status = 'held', attempts = attempts + 1, last_error = 'no_consent' where id = v_row.id;
      v_held := v_held + 1;
      continue;
    end if;

    if v_row.kind = 'join' then
      for v_rule in select * from public.derivation_rules
        where purpose = v_group.purpose and rule_kind = 'channel' and active
          and (season is null or season = v_group.season) loop
        select id into v_channel_id from public.channels where group_id = v_row.group_id and name = (v_rule.spec->>'channel_name');
        if v_channel_id is null then
          insert into public.channels (group_id, kind, name)
          values (v_row.group_id, coalesce(v_rule.spec->>'kind', 'thread'), v_rule.spec->>'channel_name')
          returning id into v_channel_id;
        end if;
        if v_row.member_child_id is not null then
          insert into public.channel_members (channel_id, member_child_id, is_guardian_comember)
          select v_channel_id, v_row.member_child_id, false
          where not exists (select 1 from public.channel_members where channel_id = v_channel_id and member_child_id = v_row.member_child_id);
          insert into public.channel_members (channel_id, member_actor_id, is_guardian_comember)
          select v_channel_id, ch.parent_id, true from public.children ch
          where ch.id = v_row.member_child_id and ch.parent_id is not null
            and not exists (select 1 from public.channel_members cm where cm.channel_id = v_channel_id and cm.member_actor_id = ch.parent_id);
        else
          insert into public.channel_members (channel_id, member_actor_id, is_guardian_comember)
          select v_channel_id, v_row.member_actor_id, false
          where not exists (select 1 from public.channel_members where channel_id = v_channel_id and member_actor_id = v_row.member_actor_id);
        end if;
      end loop;

      for v_rule in select * from public.derivation_rules
        where purpose = v_group.purpose and rule_kind = 'requirement' and active
          and role = v_row.role and (season is null or season = v_group.season) loop
        insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
        select 'requirement', v_group.created_by, v_row.member_child_id, v_row.group_id,
               jsonb_build_object('requirement_key', v_rule.spec->>'requirement_key', 'status', 'assigned', 'rule_version', v_rule.version)
        where not exists (
          select 1 from public.events e where e.kind = 'requirement' and e.group_id = v_row.group_id
            and e.subject_child_id is not distinct from v_row.member_child_id
            and e.payload->>'requirement_key' = (v_rule.spec->>'requirement_key')
            and e.payload->>'status' = 'assigned');
      end loop;

      update public.derivation_outbox set status = 'done', processed_at = now(), attempts = attempts + 1 where id = v_row.id;
      v_processed := v_processed + 1;

    else
      update public.channel_members cm set active = false
        from public.channels c
       where c.id = cm.channel_id and c.group_id = v_row.group_id
         and cm.member_child_id is not distinct from v_row.member_child_id
         and cm.member_actor_id is not distinct from v_row.member_actor_id;
      insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
      select 'requirement', v_group.created_by, v_row.member_child_id, v_row.group_id,
             jsonb_build_object('requirement_key', e.payload->>'requirement_key', 'status', 'cancelled')
      from public.events e
      where e.kind = 'requirement' and e.group_id = v_row.group_id
        and e.subject_child_id is not distinct from v_row.member_child_id
        and e.payload->>'status' = 'assigned';
      update public.derivation_outbox set status = 'reversed', processed_at = now(), attempts = attempts + 1 where id = v_row.id;
      v_reversed := v_reversed + 1;
    end if;

    -- S5b: reconcile the group_derived work-grants to membership truth (order-insensitive; join co-mint + leave revoke)
    if v_group.purpose in ('class','team') then
      if v_row.member_child_id is not null then
        perform public.reconcile_group_grant(v_row.group_id, v_row.member_child_id);
      elsif v_row.member_actor_id is not null then
        for v_cid in
          select member_child_id from public.memberships where group_id = v_row.group_id and member_child_id is not null and active
          union
          select child_id from public.tutor_grants where tutor_id = v_row.member_actor_id and origin = 'group_derived' and origin_group_id = v_row.group_id
        loop
          perform public.reconcile_group_grant(v_row.group_id, v_cid);
        end loop;
      end if;
    end if;

    insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
    values ('derivation_audit', v_group.created_by, v_row.member_child_id, v_row.group_id,
            jsonb_build_object('outbox_id', v_row.id, 'trigger', v_row.kind));
  end loop;
  return jsonb_build_object('processed', v_processed, 'held', v_held, 'reversed', v_reversed);
end $$;
revoke all on function public.drain_derivations() from public, anon, authenticated;  -- worker/service-only (M4)

-- ---- join_group: SHOULD-FIX 2 — tighten the class/team child-add to is_my_child (spec alignment) ----
-- Identical to 0043 except the middle WHO disjunct: a NON-owner may active-add a child to a class/team
-- ONLY if it is their OWN child (was: any writer to any class/team). Matches the approved WHO — parent →
-- own child anywhere; leader → their own group (created_by); academy staff → their academy — and closes the
-- delegated-writer-adds-to-a-stranger's-class work-disclosure that S5b's co-mint would otherwise create.
-- A leader/staff adding a child they DON'T own still uses the pending request_add → parent-confirm lane.
create or replace function public.join_group(p_group_id uuid, p_member_child_id uuid, p_member_actor_id uuid, p_role text default 'member')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if (p_member_child_id is null) = (p_member_actor_id is null) then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;

  if p_member_child_id is not null then
    if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- parent-in-the-loop (COPPA)
    if not (
         v_group.created_by = v_uid                                                       -- a leader adds to their OWN group
      or (v_group.purpose in ('class','team') and public.is_my_child(p_member_child_id))  -- a parent adds their OWN child to any class/team
      or (v_group.org_id is not null and public.is_academy_staff(v_group.org_id, v_uid))  -- academy staff, in their academy
    ) then
      return jsonb_build_object('ok', false, 'error', 'not_authorized');
    end if;
    if not public.can_write_child(p_member_child_id) then                                 -- THE C1 BORDER (unchanged): write authority required
      return jsonb_build_object('ok', false, 'error', 'not_authorized');
    end if;
  else
    if v_group.created_by <> v_uid then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;  -- adult add: OWNER-ONLY
  end if;

  select id into v_membership_id from public.memberships
   where group_id = p_group_id
     and member_child_id is not distinct from p_member_child_id
     and member_actor_id is not distinct from p_member_actor_id;
  if v_membership_id is null then
    insert into public.memberships (group_id, member_child_id, member_actor_id, role, active)
    values (p_group_id, p_member_child_id, p_member_actor_id, p_role, true) returning id into v_membership_id;
  else
    update public.memberships set active = true, left_at = null, role = p_role where id = v_membership_id;
  end if;

  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('membership', v_uid, p_member_child_id, p_group_id,
          jsonb_build_object('action', 'join', 'role', p_role, 'membership_id', v_membership_id))
  returning id into v_event_id;
  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
  values (v_event_id, 'join', p_group_id, p_member_child_id, p_member_actor_id, p_role,
          'join:' || v_membership_id::text || ':' || v_event_id::text, 'pending');
  return jsonb_build_object('ok', true, 'membership_id', v_membership_id, 'event_id', v_event_id);
end $$;
revoke all on function public.join_group(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.join_group(uuid, uuid, uuid, text) to authenticated;
