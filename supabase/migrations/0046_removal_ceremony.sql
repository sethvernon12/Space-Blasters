-- ============================================================================
-- 0046_removal_ceremony.sql — Phase 5 · Group Engine · S6. THE CAREFUL-OUT REMOVAL
-- CEREMONY (the careful-out half of easy-in/careful-out). The suppression + the S5b
-- synchronous audited grant-cut are ALREADY built (0045 leave_group); S6 layers only the
-- CEREMONY: authority (who may remove) + friction (how much accountability). Removal stays
-- SUPPRESSION, never deletion (membership/channel/requirement history + the honest record +
-- all Artifacts persist; purge stays departure-only). can_view_child + is_group_member
-- UNCHANGED; role stays on the grant.
--
--   PARENT → their OWN child = leave_group (restricted to is_my_child): 1 tap, no why-note, undo = re-add.
--   LEADER (created_by) / ACADEMY (is_academy_staff) → someone else's child = remove_member: a non-empty
--     WHY-NOTE + explicit CONFIRM (empty why-note → rejected, nothing changes); suppress + the S5b
--     synchronous grant-cut; auto-notify the parent (a NEUTRAL child-subject removal FACT, DER-09); the
--     WHY-NOTE stored ADULT-SCOPED (parent + author/leader/academy, NEVER the child — P7).
--   A non-parent can NEVER permanently sever: the parent can always re-add (join_group reactivates the row).
--   FLAG: a member who is not the leader flags a wrong member (flag_member) for the leader/academy to act on.
-- Forward-only. DEV/local only. MUST be SEC-03'd before any apply.
-- ============================================================================

-- ---- membership_removals: the ADULT-SCOPED accountability record (why-notes + flags; NEVER child-visible) --
create table public.membership_removals (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('flag','removed')),        -- a request-to-remove, or an actual removal
  group_id        uuid not null references public.groups(id)   on delete cascade,
  member_child_id uuid not null references public.children(id) on delete restrict,  -- child-keyed → purge_child + receipt
  actor_id        uuid not null,                                            -- the flagger (flag) or the remover (removed)
  note            text not null,                                            -- the flag reason / removal why-note (ADULT-SCOPED, P7)
  created_at      timestamptz not null default now()
);
create index membership_removals_child_idx on public.membership_removals (member_child_id);
create index membership_removals_group_idx on public.membership_removals (group_id, kind);
alter table public.membership_removals enable row level security;
alter table public.membership_removals force  row level security;
-- ADULT-SCOPED read (P7): the author, the child's PARENT (a guardian who is NOT a child actor), or the
-- group's LEADER — so a flag surfaces to the leader and a removal's why-note reaches the parent. The CHILD
-- (is_child_actor_self) is excluded from the guardian branch, and a child is never a group leader → the
-- accountability reason NEVER reaches the child. No client writes (flag_member / remove_member RPCs only).
create policy membership_removals_select on public.membership_removals for select to authenticated
  using (
    actor_id = auth.uid()
    or (public.is_my_child(member_child_id) and not public.is_child_actor_self())
    or public.is_group_leader(group_id, auth.uid())
  );
revoke all on public.membership_removals from public, anon;
grant select on public.membership_removals to authenticated;
grant all on public.membership_removals to service_role;

-- ---- leave_group: RESTRICTED to the PARENT's own-child 1-tap removal (a leader/academy uses remove_member) --
-- Identical to 0045 except the authority: only a guardian removing their OWN child (is_my_child). A leader
-- can no longer 1-tap a child around the documented ceremony. (Every existing caller already uses is_my_child.)
create or replace function public.leave_group(p_group_id uuid, p_member_child_id uuid, p_member_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_role text;
  v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  -- S6: PARENT's OWN child only. Leader/academy removal of someone else's child → remove_member (why-note).
  if not (p_member_child_id is not null and public.is_my_child(p_member_child_id)) then
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

  -- S5b SYNCHRONOUS cut (unchanged): reconcile the affected group_derived work-grant NOW.
  if v_group.purpose in ('class','team') and p_member_child_id is not null then
    perform public.reconcile_group_grant(p_group_id, p_member_child_id);
  end if;
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;
revoke all on function public.leave_group(uuid, uuid, uuid) from public, anon;
grant execute on function public.leave_group(uuid, uuid, uuid) to authenticated;

-- ---- remove_member: the DOCUMENTED leader/academy removal of someone else's child ----
create or replace function public.remove_member(p_group_id uuid, p_member_child_id uuid, p_why_note text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_role text;
  v_event_id uuid;
  v_note text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if p_member_child_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  v_note := left(btrim(coalesce(p_why_note, ''), E' \t\n\r\f\v'), 2000);   -- strip ALL whitespace (a tab/newline-only note is empty)
  if v_note = '' then return jsonb_build_object('ok', false, 'error', 'why_required'); end if;   -- NO removal without a why-note + confirm
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  -- AUTHORITY: the group's LEADER (created_by) or the ACADEMY (staff of the group's academy). Never a stranger.
  if not (v_group.created_by = v_uid
          or (v_group.org_id is not null and public.is_academy_staff(v_group.org_id, v_uid))) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  -- SHOULD-FIX 2: scope to class/team — the reconcile + the parent's join_group re-add are class/team-only, so a
  -- non-class/team removal here could not be undone by the parent (parent-supreme gap). Family departures use
  -- leave_group; children are never direct academy/follower_circle members.
  if v_group.purpose not in ('class','team') then return jsonb_build_object('ok', false, 'error', 'bad_purpose'); end if;
  select id, role into v_membership_id, v_role from public.memberships
   where group_id = p_group_id and member_child_id = p_member_child_id and member_actor_id is null and active;
  if v_membership_id is null then return jsonb_build_object('ok', false, 'error', 'not_a_member'); end if;

  -- SUPPRESSION (never deletion): the row + all history persist.
  update public.memberships set active = false, left_at = now() where id = v_membership_id;
  -- NEUTRAL child-subject removal FACT (DER-09 parent-notify). The child sees only the neutral fact (P7);
  -- the why-note is NOT here — it lives adult-scoped in membership_removals below.
  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('membership', v_uid, p_member_child_id, p_group_id,
          jsonb_build_object('action', 'removed', 'membership_id', v_membership_id))
  returning id into v_event_id;
  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
  values (v_event_id, 'leave', p_group_id, p_member_child_id, null, coalesce(v_role, 'member'),
          'leave:' || v_membership_id::text || ':' || v_event_id::text, 'pending');
  -- S5b SYNCHRONOUS grant-cut + audited reconcile (immediate careful-out)
  if v_group.purpose in ('class','team') then
    perform public.reconcile_group_grant(p_group_id, p_member_child_id);
  end if;
  -- ADULT-SCOPED why-note (accountability; parent + author/leader/academy, NEVER the child — P7)
  insert into public.membership_removals (kind, group_id, member_child_id, actor_id, note)
  values ('removed', p_group_id, p_member_child_id, v_uid, v_note);
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'membership.removed', p_member_child_id, 'allow', jsonb_build_object('group_id', p_group_id));
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;
revoke all on function public.remove_member(uuid, uuid, text) from public, anon;
grant execute on function public.remove_member(uuid, uuid, text) to authenticated;

-- ---- flag_member: a member (e.g. a co-tutor) who is not the leader flags a wrong member for the leader ----
create or replace function public.flag_member(p_group_id uuid, p_member_child_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_note text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  -- SHOULD-FIX 1: a CHILD actor can never file a flag (is_group_member is true for a child's own login via the
  -- own-child branch) — parent-in-the-loop; flagging is an adult accountability action.
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_member_child_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  v_note := left(btrim(coalesce(p_note, ''), E' \t\n\r\f\v'), 2000);   -- strip ALL whitespace
  if v_note = '' then return jsonb_build_object('ok', false, 'error', 'note_required'); end if;
  if not exists (select 1 from public.groups where id = p_group_id) then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  -- a MEMBER of the group flags; the flag surfaces to the group's LEADER/academy (membership_removals RLS)
  if not public.is_group_member(p_group_id) then return jsonb_build_object('ok', false, 'error', 'not_a_member'); end if;
  if not exists (select 1 from public.memberships where group_id = p_group_id and member_child_id = p_member_child_id and active) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member_child'); end if;
  insert into public.membership_removals (kind, group_id, member_child_id, actor_id, note)
  values ('flag', p_group_id, p_member_child_id, v_uid, v_note);
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'membership.flag', p_member_child_id, 'allow', jsonb_build_object('group_id', p_group_id));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.flag_member(uuid, uuid, text) from public, anon;
grant execute on function public.flag_member(uuid, uuid, text) to authenticated;

-- ---- purge_child: fold membership_removals into the RESTRICT loop + receipt (supersedes 0043) ----
-- Identical to 0043 except membership_removals is deleted (before children, RESTRICT) + receipt-bucketed.
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
  d_gjobs int; d_gprop int; d_gledger int; d_mreq int; d_removals int;
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
  delete from public.membership_removals where member_child_id = p_child_id;   get diagnostics d_removals = row_count;   -- S6: removal/flag records (RESTRICT)
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
