-- ============================================================================
-- 0043_distributed_add.sql — Phase 5 · Group Engine · S4. DISTRIBUTED SPLIT-GATE ADD.
-- Easy-in / careful-out (careful-out = S6). Two lanes:
--   ACTIVE lane (join_group, relaxed): WHO-may-initiate widens from OWNER-ONLY to
--     distributed — a parent adds their OWN child to any class/team; a leader adds to
--     their own group; academy staff add to a group in their academy. The can_write_child
--     gate is KEPT BYTE-FOR-BYTE, so a cross-family child can NEVER become an active
--     membership through this lane (C1 invariant; only WHO widens). Adult adds stay OWNER-ONLY.
--   PENDING lane (request_add → membership_requests): a leader/staff proposing a child they
--     lack write authority over (cross-family) creates a REQUEST ROW ONLY — NO membership,
--     NO event, NO outbox, NO drain, NO channel co-membership, NO grant. Because no
--     membership exists, S3's memberships_select (incl. the is_group_leader branch) has
--     NOTHING to surface — the cross-family border holds BY ABSENCE, with S3 literally
--     unchanged. The child's OWN parent confirms (confirm_add) to materialize the active
--     membership (behind can_write_child, re-checked). decline/cancel materialize nothing.
--
-- membership_requests is child-keyed (member_child_id ON DELETE RESTRICT → joins the
-- purge_child accounting loop + receipt; group_id ON DELETE CASCADE). RLS enabled+FORCED
-- with ZERO client policies (deny-by-default) — ALL access is through the SECURITY DEFINER
-- RPCs below, whose gate logic is exactly "requested_by OR can_write_child(child)".
--
-- can_view_child (work) is UNTOUCHED (work is S5's grant). is_group_member + the S3 policies
-- are UNCHANGED. Forward-only. DEV/local only. MUST be SEC-03'd before any DEV/prod apply.
-- ============================================================================

-- ---- membership_requests: the pending cross-family add lane (NO membership) ----
create table public.membership_requests (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.groups(id)   on delete cascade,
  member_child_id  uuid not null references public.children(id) on delete restrict,  -- child-keyed → RESTRICT (deletion covenant)
  requested_by     uuid not null,                                -- the leader/staff who proposed the add
  requested_role   text not null default 'member',
  status           text not null default 'pending' check (status in ('pending','confirmed','declined','cancelled')),
  reason           text,
  created_at       timestamptz not null default now(),
  resolved_by      uuid,
  resolved_at      timestamptz
);
-- at most ONE open request per (group, child) → re-request is a no-op, not a duplicate
create unique index membership_requests_pending_uniq
  on public.membership_requests (group_id, member_child_id) where status = 'pending';
create index membership_requests_child_idx on public.membership_requests (member_child_id);
alter table public.membership_requests enable row level security;
alter table public.membership_requests force  row level security;
-- NO policies: deny-by-default. All reads/writes go through the SECURITY DEFINER RPCs below,
-- which enforce the "requested_by OR can_write_child(child)" gate in code.
revoke all on public.membership_requests from public, anon, authenticated;

-- ---- join_group (relaxed ACTIVE lane; supersedes 0011:36-76) ----
-- CHILD add: distributed WHO (leader OR any class/team OR academy-staff-of-the-group's-academy)
--   AND the UNCHANGED can_write_child gate (the C1 border). ADULT add: OWNER-ONLY (unchanged).
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
    -- parent-in-the-loop (COPPA): a CHILD actor can never initiate an add — adds come from
    -- parent/leader/staff, never the child self-enrolling (can_write_child(self) is true, so
    -- without this a child login could self-disclose into any class/team).
    if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
    -- WHO-may-initiate a CHILD add (S4 distributed; supersedes owner-only): the leader/owner, OR
    -- any WRITE-AUTHORIZED party into a class/team (a parent's own child, OR a parent-delegated
    -- writable tutor_grant holder — can_write_child, never a stranger), OR academy staff of the
    -- academy that owns the group.
    if not (
         v_group.created_by = v_uid
      or v_group.purpose in ('class','team')
      or (v_group.org_id is not null and public.is_academy_staff(v_group.org_id, v_uid))
    ) then
      return jsonb_build_object('ok', false, 'error', 'not_authorized');
    end if;
    -- THE C1 BORDER (UNCHANGED from 0011:53-55): a child add requires write authority, so a
    -- cross-family child can NEVER become an active membership here (it must use the pending lane).
    if not public.can_write_child(p_member_child_id) then
      return jsonb_build_object('ok', false, 'error', 'not_authorized');
    end if;
  else
    -- ADULT add stays OWNER-ONLY (unchanged): only the leader manages the adult roster.
    if v_group.created_by <> v_uid then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
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

-- ---- request_add: the PENDING cross-family lane (NO membership) ----
-- A leader (created_by) or academy staff proposes a child they lack write authority over.
-- Creates a membership_requests row only. Idempotent per (group, child) pending request.
create or replace function public.request_add(p_group_id uuid, p_member_child_id uuid, p_role text default 'member', p_reason text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_group public.groups%rowtype; v_req_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if p_member_child_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  if v_group.purpose not in ('class','team') then return jsonb_build_object('ok', false, 'error', 'bad_purpose'); end if;
  -- WHO-may-request FIRST (fail-closed; the child-existence check is AFTER authz so a non-leader
  -- can never use the 'unknown_child' vs 'not_authorized' split as a child-existence oracle).
  if not (
       v_group.created_by = v_uid
    or (v_group.org_id is not null and public.is_academy_staff(v_group.org_id, v_uid))
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if not exists (select 1 from public.children where id = p_member_child_id) then return jsonb_build_object('ok', false, 'error', 'unknown_child'); end if;
  -- the PENDING lane is CROSS-FAMILY only: if the caller already has write authority, the active
  -- lane (join_group) is correct — steer them there rather than create a pointless pending request.
  if public.can_write_child(p_member_child_id) then return jsonb_build_object('ok', false, 'error', 'use_active_add'); end if;

  -- idempotent: an open request already exists → return it (never a duplicate)
  select id into v_req_id from public.membership_requests
   where group_id = p_group_id and member_child_id = p_member_child_id and status = 'pending';
  if v_req_id is null then
    insert into public.membership_requests (group_id, member_child_id, requested_by, requested_role, reason)
    values (p_group_id, p_member_child_id, v_uid, coalesce(p_role, 'member'), p_reason)
    returning id into v_req_id;
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'membership.request', p_member_child_id, 'allow',
            jsonb_build_object('group_id', p_group_id, 'request_id', v_req_id));
  end if;
  return jsonb_build_object('ok', true, 'request_id', v_req_id, 'status', 'pending');
end $$;
revoke all on function public.request_add(uuid, uuid, text, text) from public, anon;
grant execute on function public.request_add(uuid, uuid, text, text) to authenticated;

-- ---- confirm_add: the child's OWN parent materializes the active membership ----
-- Authz = can_write_child(child) (the requester CANNOT self-confirm — they lack it, that's why
-- they used the pending lane). Materializes via join_group (can_write_child re-checked there).
create or replace function public.confirm_add(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_req public.membership_requests%rowtype; v_jr jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  -- parent-in-the-loop (COPPA): a CHILD actor can never confirm — even their own request. Consent
  -- to participate is the PARENT's, never the child's self-consent (can_write_child(self) is true).
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.membership_requests where id = p_request_id for update;
  if v_req.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status = 'confirmed' then return jsonb_build_object('ok', true, 'idempotent', true, 'status', 'confirmed'); end if;
  if v_req.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'not_pending'); end if;
  -- ONLY the child's own parent/guardian (write authority) confirms — never the requester/leader.
  if not public.can_write_child(v_req.member_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;

  -- materialize the ACTIVE membership through the active lane (behind can_write_child).
  v_jr := public.join_group(v_req.group_id, v_req.member_child_id, null, v_req.requested_role);
  if not coalesce((v_jr->>'ok')::boolean, false) then return v_jr; end if;

  update public.membership_requests set status = 'confirmed', resolved_by = v_uid, resolved_at = now() where id = p_request_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'membership.confirm', v_req.member_child_id, 'allow',
          jsonb_build_object('group_id', v_req.group_id, 'request_id', p_request_id, 'membership_id', v_jr->>'membership_id'));
  return jsonb_build_object('ok', true, 'status', 'confirmed', 'membership_id', v_jr->>'membership_id');
end $$;
revoke all on function public.confirm_add(uuid) from public, anon;
grant execute on function public.confirm_add(uuid) to authenticated;

-- ---- decline_add: the parent declines, or the requester cancels — materializes nothing ----
create or replace function public.decline_add(p_request_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_req public.membership_requests%rowtype; v_is_parent boolean; v_status text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_req from public.membership_requests where id = p_request_id for update;
  if v_req.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'not_pending'); end if;
  v_is_parent := public.can_write_child(v_req.member_child_id);
  -- the child's parent DECLINES; the requester CANCELS their own request. No one else.
  if not (v_is_parent or v_req.requested_by = v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_status := case when v_is_parent then 'declined' else 'cancelled' end;
  update public.membership_requests
     set status = v_status, resolved_by = v_uid, resolved_at = now(),
         reason = coalesce(p_reason, reason)
   where id = p_request_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'membership.' || v_status, v_req.member_child_id, 'allow',
          jsonb_build_object('group_id', v_req.group_id, 'request_id', p_request_id));
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;
revoke all on function public.decline_add(uuid, text) from public, anon;
grant execute on function public.decline_add(uuid, text) to authenticated;

-- ---- my_pending_add_requests: the cockpit read (parent's pending confirmations + own requests) --
-- Gate logic is exactly the intended RLS: a row is visible only to the REQUESTER or the child's
-- own parent/guardian (can_write_child). Never co-members / other leaders / other families.
create or replace function public.my_pending_add_requests()
returns table (id uuid, group_id uuid, member_child_id uuid, requested_by uuid, requested_role text, reason text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.group_id, r.member_child_id, r.requested_by, r.requested_role, r.reason, r.created_at
  from public.membership_requests r
  where r.status = 'pending'
    and (r.requested_by = auth.uid() or public.can_write_child(r.member_child_id))
$$;
revoke all on function public.my_pending_add_requests() from public, anon;
grant execute on function public.my_pending_add_requests() to authenticated;

-- ---- purge_child: fold membership_requests into the RESTRICT loop + receipt (supersedes 0028) --
-- Identical to 0028 except membership_requests is deleted (before children, RESTRICT) and
-- receipt-bucketed. The deletion covenant stays complete: every child-keyed table accounted.
create or replace function public.purge_child(p_child_id uuid, p_parent_id uuid, p_deleting_actor uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_child public.children%rowtype;
  v_auth_user uuid; v_revoke_id uuid; v_receipt public.deletion_receipts%rowtype;
  v_prev_hash text; v_hash text; v_disp jsonb; v_ent text := 'kept';
  d_attempts int; d_sessions int; d_mastery int; d_misc int; d_assess int;
  d_assign int; d_subs int; d_arts int; d_mints int; d_grants int;
  d_mem int; d_chmem int; d_outbox int; d_subjevents int; t_msgs int; d_uploads int; d_inv int;
  d_gjobs int; d_gprop int; d_gledger int; d_mreq int;
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
  delete from public.grade_proposals where child_id = p_child_id;             get diagnostics d_gprop = row_count;   -- before grade_jobs (FK) + before children (RESTRICT)
  delete from public.grade_jobs where child_id = p_child_id;                  get diagnostics d_gjobs = row_count;
  delete from public.grade_cost_ledger where child_id = p_child_id;           get diagnostics d_gledger = row_count;
  delete from public.uploads where child_id = p_child_id;                     get diagnostics d_uploads = row_count;  -- rows (RESTRICT); OBJECTS purged by the worker
  delete from public.invitations where target_child_id = p_child_id;          get diagnostics d_inv = row_count;
  delete from public.child_skill_mastery where child_id = p_child_id;          get diagnostics d_mastery = row_count;
  delete from public.child_skill_misconception where child_id = p_child_id;    get diagnostics d_misc = row_count;
  delete from public.child_skill_assessment where child_id = p_child_id;       get diagnostics d_assess = row_count;
  delete from public.sessions where child_id = p_child_id;                     get diagnostics d_sessions = row_count;
  delete from public.assignments where child_id = p_child_id;                  get diagnostics d_assign = row_count;
  delete from public.child_session_mints where child_id = p_child_id;          get diagnostics d_mints = row_count;
  delete from public.tutor_grants where child_id = p_child_id;                 get diagnostics d_grants = row_count;
  delete from public.membership_requests where member_child_id = p_child_id;   get diagnostics d_mreq = row_count;    -- S4: pending cross-family adds (RESTRICT)
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
      'child_session_mints', d_mints, 'tutor_grants', d_grants, 'membership_requests', d_mreq,
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
