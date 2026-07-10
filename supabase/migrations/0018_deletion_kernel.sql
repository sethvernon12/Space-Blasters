-- ============================================================================
-- 0018_deletion_kernel.sql — Slice A: consent revocation -> hard deletion.
-- LOCAL ONLY, additive. Joins the Slice-A SEC-03 review (the five-lens MUST-FIX
-- list is the review's checklist floor) before any DEV apply.
--
-- HARD RULE #6: "delete" = hard-delete across DB (Storage/CDN/AI-provider purge is
-- Slice B) with an immutable DELETION RECEIPT and a durable, verifiable proof.
--
-- Design (folds the five-lens review):
--   * DISPOSITION MATRIX, not a blanket cascade (#7): child-private data is
--     hard-deleted; child-authored messages in shared channels are TOMBSTONED
--     (row + chronology kept, body redacted); consent_ledger/audit_log/
--     stripe_events are RETAINED as evidence (child_id de-FK'd to a plain value so
--     they survive the child's deletion).
--   * STRUCTURAL COMPLETENESS backstop (#3): every child-keyed DATA table's FK to
--     children becomes ON DELETE RESTRICT and children is deleted LAST, so any
--     table the kernel forgets FK-blocks the final delete (loud rollback, never a
--     silent partial purge). Only evidence tables are de-FK'd.
--   * ZOMBIE-WRITE defense (#8): the ONE client-writable table keyed to auth.uid()
--     with no children join (suppressions) gains a deletion-tombstone guard, so a
--     captured pre-purge child JWT cannot write after the receipt exists. Every
--     other child-write path already joins a live children row and fails closed.
--   * IDEMPOTENT (#9): unique(child_id) receipt + FOR UPDATE on the child row; a
--     second/concurrent call returns the existing receipt, never a second revoke.
--   * LEGAL HOLD (#6): checked inside purge_child — records the request, no
--     destruction.
--   * TWO-SYSTEM SEAM (#2): purge_child captures child_auth_user_id BEFORE the row
--     dies and writes the receipt as 'pending_auth_cleanup'; the Edge function
--     revokes sessions -> purges -> deletes the GoTrue user -> complete_child_deletion
--     flips the receipt to 'completed'. A reconciliation list drains stragglers.
--   * VERIFIABLE RECEIPT (#SHOULD): immutable, hash over the receipt's own readable
--     fields chained to prev_receipt_hash + the revoke row id (not a hash of
--     deleted data). PITR export/runbook + email anchor are Slice B.
--
-- DEFINER HYGIENE: every function is SECURITY DEFINER, set search_path='',
-- schema-qualified, EXECUTE revoked from public/anon/authenticated and granted
-- only where needed. Evidence tables already block UPDATE/DELETE (forbid_mutation);
-- the kernel reaches through that ONE reviewed path via a tx-local GUC.
-- ============================================================================

-- ---- 1. forbid_mutation: authorized-purge passthrough -----------------------
-- Only the reviewed deletion kernel sets app.purge='on' (transaction-local). A
-- client can never reach this branch usefully: clients hold no UPDATE/DELETE grant
-- on any immutable table, so the real gate is table privilege; this is a
-- belt-and-suspenders passthrough for purge_child's disposition steps.
create or replace function public.forbid_mutation() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_setting('app.purge', true) = 'on' then return coalesce(new, old); end if;
  raise exception '% rows are append-only/immutable', tg_table_name;
end $$;

-- ---- 2. legal_holds: service-only quarantine flag (survives child deletion) --
create table if not exists public.legal_holds (
  child_id    uuid primary key,      -- plain uuid: must outlive the children row
  reason      text,
  placed_by   uuid,
  placed_at   timestamptz not null default now(),
  released_at timestamptz
);
alter table public.legal_holds enable row level security;
alter table public.legal_holds force row level security;
revoke all on public.legal_holds from public, anon, authenticated;   -- service/definer only

-- ---- 3. deletion_receipts: immutable, hash-chained proof --------------------
create table if not exists public.deletion_receipts (
  id                 uuid primary key default gen_random_uuid(),
  child_id           uuid not null unique,          -- plain (de-FK'd); idempotency key
  parent_id          uuid not null,
  child_auth_user_id uuid,                           -- captured BEFORE the child row dies
  deleting_actor     uuid not null,
  revoke_consent_id  uuid,                           -- the consent_ledger revoke row id
  disposition        jsonb not null,                 -- {deleted:{}, tombstoned:{}, retained:[], entitlement:...}
  prev_receipt_hash  text,
  receipt_hash       text not null,
  status             text not null default 'pending_auth_cleanup'
                       check (status in ('pending_auth_cleanup', 'completed', 'legal_hold_blocked')),
  db_purged_at       timestamptz not null default now(),
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);
alter table public.deletion_receipts enable row level security;
alter table public.deletion_receipts force row level security;
revoke all on public.deletion_receipts from public, anon, authenticated;
grant select on public.deletion_receipts to authenticated;
drop policy if exists deletion_receipts_select on public.deletion_receipts;
-- a parent reads their own receipts (proof of deletion); no client writes ever.
create policy deletion_receipts_select on public.deletion_receipts for select to authenticated
  using (parent_id = auth.uid());

-- immutable EXCEPT the one-way pending_auth_cleanup -> completed transition, so the
-- substantive fields + hash stay frozen while the two-system completion is recorded.
create or replace function public.deletion_receipt_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'deletion_receipts is immutable'; end if;
  if old.status = 'pending_auth_cleanup' and new.status = 'completed'
     and old.completed_at is null and new.completed_at is not null
     and new.id = old.id and new.child_id = old.child_id and new.parent_id = old.parent_id
     and new.child_auth_user_id is not distinct from old.child_auth_user_id
     and new.deleting_actor = old.deleting_actor
     and new.revoke_consent_id is not distinct from old.revoke_consent_id
     and new.disposition = old.disposition
     and new.prev_receipt_hash is not distinct from old.prev_receipt_hash
     and new.receipt_hash = old.receipt_hash and new.db_purged_at = old.db_purged_at then
    return new;
  end if;
  raise exception 'deletion_receipts: only the auth-cleanup completion transition is permitted';
end $$;
drop trigger if exists deletion_receipts_guard on public.deletion_receipts;
create trigger deletion_receipts_guard before update or delete on public.deletion_receipts
  for each row execute function public.deletion_receipt_guard();

-- ---- 4. EVIDENCE de-FK: audit_log (was CASCADE — would destroy evidence) and
--         consent_ledger (was NO ACTION — would block the child delete). Both keep
--         child_id as a plain uuid and are RETAINED. -----------------------------
do $$
declare n text;
begin
  select conname into n from pg_constraint
    where conrelid = 'public.audit_log'::regclass and contype = 'f'
      and confrelid = 'public.children'::regclass;
  if n is not null then execute format('alter table public.audit_log drop constraint %I', n); end if;
  select conname into n from pg_constraint
    where conrelid = 'public.consent_ledger'::regclass and contype = 'f'
      and confrelid = 'public.children'::regclass;
  if n is not null then execute format('alter table public.consent_ledger drop constraint %I', n); end if;
end $$;

-- ---- 5. DATA-table FKs -> ON DELETE RESTRICT (structural completeness backstop)
do $$
declare r record; n text;
begin
  for r in select * from (values
    ('attempts','child_id'), ('sessions','child_id'), ('child_skill_mastery','child_id'),
    ('child_skill_misconception','child_id'), ('child_skill_assessment','child_id'),
    ('assignments','child_id'), ('submissions','child_id'), ('teaching_artifacts','child_id'),
    ('child_session_mints','child_id'), ('tutor_grants','child_id'),
    ('memberships','member_child_id'), ('channel_members','member_child_id'),
    ('derivation_outbox','member_child_id'), ('events','subject_child_id')
  ) as t(tbl, col) loop
    select conname into n from pg_constraint
      where conrelid = ('public.' || r.tbl)::regclass and contype = 'f'
        and confrelid = 'public.children'::regclass;
    if n is not null then execute format('alter table public.%I drop constraint %I', r.tbl, n); end if;
    execute format('alter table public.%I add constraint %I foreign key (%I) references public.children(id) on delete restrict',
                   r.tbl, r.tbl || '_' || r.col || '_children_restrict', r.col);
  end loop;
end $$;

-- ---- 6. actor_is_deleted + suppressions zombie-write guard (#8) --------------
-- A deletion receipt is the durable revocation TOMBSTONE. The only client-writable
-- table keyed to auth.uid() without a live children join is suppressions; gate its
-- writes so a captured pre-purge child token can't write after deletion. (Adults
-- have no receipt, so their opt-outs are unaffected.)
create or replace function public.actor_is_deleted(p_uid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.deletion_receipts where child_auth_user_id = p_uid) $$;
revoke all on function public.actor_is_deleted(uuid) from public, anon;
grant execute on function public.actor_is_deleted(uuid) to authenticated;

drop policy if exists suppressions_insert on public.suppressions;
create policy suppressions_insert on public.suppressions for insert to authenticated
  with check (actor_id = auth.uid() and not public.actor_is_deleted(auth.uid()));
drop policy if exists suppressions_update on public.suppressions;
create policy suppressions_update on public.suppressions for update to authenticated
  using (actor_id = auth.uid() and not public.actor_is_deleted(auth.uid()))
  with check (actor_id = auth.uid() and not public.actor_is_deleted(auth.uid()));

-- groups is the OTHER client-writable surface keyed on auth.uid() with no children
-- join; guard it the same way so a captured pre-purge child token can't create an
-- orphan group after deletion. (Every remaining child-write path joins a live
-- children row and already fails closed.)
drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups for insert to authenticated
  with check (created_by = auth.uid() and not public.actor_is_deleted(auth.uid()));

-- mint TOCTOU (#SHOULD): a child with a deletion receipt can never be re-minted.
-- (The children row is already gone so ownership fails; this is explicit tombstone
-- defense against any re-materialization with the same child_id.)
create or replace function public.authorize_and_record_mint(p_child_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_auth_user uuid; v_exists uuid; v_recent int;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select count(*) into v_recent from public.child_session_mints
   where parent_id = v_uid and created_at > now() - interval '60 seconds';
  if v_recent >= 10 then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'child.session.mint', null, 'deny', jsonb_build_object('source', 'provisioning', 'reason', 'rate_limited'));
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if exists (select 1 from public.deletion_receipts where child_id = p_child_id) then
    insert into public.child_session_mints (parent_id, child_id) values (v_uid, null);
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'child.session.mint', null, 'deny', jsonb_build_object('source', 'provisioning', 'reason', 'deleted'));
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id into v_exists from public.children where id = p_child_id;
  select auth_user_id into v_auth_user from public.children where id = p_child_id and parent_id = v_uid;
  insert into public.child_session_mints (parent_id, child_id) values (v_uid, v_exists);
  if v_auth_user is null then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'child.session.mint', v_exists, 'deny', jsonb_build_object('source', 'provisioning', 'reason', 'not_parent'));
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (v_uid, 'child.session.mint', p_child_id, 'allow', jsonb_build_object('source', 'provisioning'));
  return jsonb_build_object('ok', true, 'auth_user_id', v_auth_user);
end $$;
revoke all on function public.authorize_and_record_mint(uuid) from public, anon;
grant execute on function public.authorize_and_record_mint(uuid) to authenticated;

-- ---- 7. delete-attempt rate limit (service-only) ----------------------------
create table if not exists public.deletion_attempts (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists deletion_attempts_rate_idx on public.deletion_attempts (parent_id, created_at);
alter table public.deletion_attempts enable row level security;
alter table public.deletion_attempts force row level security;
revoke all on public.deletion_attempts from public, anon, authenticated;

create or replace function public.record_deletion_attempt(p_parent_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_recent int;
begin
  if p_parent_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  delete from public.deletion_attempts where created_at < now() - interval '1 hour';  -- opportunistic TTL sweep
  select count(*) into v_recent from public.deletion_attempts
   where parent_id = p_parent_id and created_at > now() - interval '60 seconds';
  insert into public.deletion_attempts (parent_id) values (p_parent_id);
  if v_recent >= 5 then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.record_deletion_attempt(uuid) from public, anon, authenticated;
grant execute on function public.record_deletion_attempt(uuid) to service_role;

-- ---- 8. purge_child: the atomic disposition-matrix kernel (service-only) -----
create or replace function public.purge_child(p_child_id uuid, p_parent_id uuid, p_deleting_actor uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_child public.children%rowtype;
  v_auth_user uuid; v_revoke_id uuid; v_receipt public.deletion_receipts%rowtype;
  v_prev_hash text; v_hash text; v_disp jsonb; v_ent text := 'kept';
  d_attempts int; d_sessions int; d_mastery int; d_misc int; d_assess int;
  d_assign int; d_subs int; d_arts int; d_mints int; d_grants int;
  d_mem int; d_chmem int; d_outbox int; d_subjevents int; t_msgs int;
begin
  if p_child_id is null or p_parent_id is null or p_deleting_actor is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  -- bounded tx (#SHOULD)
  perform set_config('lock_timeout', '5000', true);
  perform set_config('statement_timeout', '30000', true);

  -- idempotency (#9): an existing receipt => already purged; return it, never a 2nd revoke
  select * into v_receipt from public.deletion_receipts where child_id = p_child_id;
  if v_receipt.id is not null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'receipt_id', v_receipt.id,
      'child_auth_user_id', v_receipt.child_auth_user_id, 'status', v_receipt.status,
      'receipt_hash', v_receipt.receipt_hash, 'disposition', v_receipt.disposition);
  end if;

  -- serialize concurrent deletes/mints on this child
  select * into v_child from public.children where id = p_child_id for update;
  if v_child.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_child.parent_id is distinct from p_parent_id then
    return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  v_auth_user := v_child.auth_user_id;   -- capture BEFORE the row dies (#2)

  -- LEGAL HOLD (#6): record + quarantine, NO destruction
  if exists (select 1 from public.legal_holds where child_id = p_child_id and released_at is null) then
    insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (p_deleting_actor, 'child.delete', p_child_id, 'deny', jsonb_build_object('reason', 'legal_hold', 'source', 'deletion'));
    return jsonb_build_object('ok', false, 'error', 'legal_hold');
  end if;

  -- authorize the immutable-table disposition steps for THIS tx only
  perform set_config('app.purge', 'on', true);

  -- (a) append the immutable consent REVOKE row (evidence; child_id de-FK'd -> survives)
  insert into public.consent_ledger (parent_id, child_id, action, method, policy_version, detail)
  values (p_parent_id, p_child_id, 'revoke',
          coalesce((select method from public.consent_ledger where child_id = p_child_id and action = 'grant' order by created_at limit 1), 'other_vpc'),
          coalesce((select policy_version from public.consent_ledger where child_id = p_child_id and action = 'grant' order by created_at desc limit 1), 'v1'),
          jsonb_build_object('source', 'deletion', 'deleting_actor', p_deleting_actor))
  returning id into v_revoke_id;

  -- (b) TOMBSTONE child-authored messages (keep row + chronology, redact body) (#7)
  if v_auth_user is not null then
    update public.events
       set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{body}', to_jsonb('[removed: child record deleted]'::text))
     where kind = 'message' and author_actor_id = v_auth_user;
    get diagnostics t_msgs = row_count;
  else t_msgs := 0; end if;

  -- (c) HARD-DELETE child-private data. ORDER MATTERS: two inter-table FKs exist
  -- (submissions.assignment_id -> assignments; attempts.session_id -> sessions),
  -- so a REFERENCING table is deleted before the one it references, else the FK
  -- would abort the whole atomic tx and deletion could never complete.
  delete from public.attempts where child_id = p_child_id;                    get diagnostics d_attempts = row_count;   -- -> sessions
  delete from public.submissions where child_id = p_child_id;                 get diagnostics d_subs = row_count;      -- -> assignments
  delete from public.teaching_artifacts where child_id = p_child_id;          get diagnostics d_arts = row_count;      -- self-ref supersedes_id (one stmt)
  delete from public.child_skill_mastery where child_id = p_child_id;          get diagnostics d_mastery = row_count;
  delete from public.child_skill_misconception where child_id = p_child_id;    get diagnostics d_misc = row_count;
  delete from public.child_skill_assessment where child_id = p_child_id;       get diagnostics d_assess = row_count;
  delete from public.sessions where child_id = p_child_id;                     get diagnostics d_sessions = row_count;  -- after attempts
  delete from public.assignments where child_id = p_child_id;                  get diagnostics d_assign = row_count;    -- after submissions
  delete from public.child_session_mints where child_id = p_child_id;          get diagnostics d_mints = row_count;
  delete from public.tutor_grants where child_id = p_child_id;                 get diagnostics d_grants = row_count;
  delete from public.memberships where member_child_id = p_child_id;           get diagnostics d_mem = row_count;
  delete from public.channel_members where member_child_id = p_child_id;       get diagnostics d_chmem = row_count;
  delete from public.derivation_outbox where member_child_id = p_child_id;     get diagnostics d_outbox = row_count;   -- sweep pending (#8)
  delete from public.events where subject_child_id = p_child_id;               get diagnostics d_subjevents = row_count;

  -- (d) children LAST — RESTRICT backstop: any missed child-keyed row FK-blocks here
  delete from public.children where id = p_child_id;

  -- (e) entitlement: keep the family entitlement UNLESS this was the last child
  if not exists (select 1 from public.children where parent_id = p_parent_id) then
    update public.entitlements set status = 'canceled' where parent_id = p_parent_id and status = 'active';
    if found then v_ent := 'canceled_last_child'; end if;
  end if;

  -- (f) disposition + hash-chained receipt
  v_disp := jsonb_build_object(
    'deleted', jsonb_build_object('attempts', d_attempts, 'sessions', d_sessions, 'child_skill_mastery', d_mastery,
      'child_skill_misconception', d_misc, 'child_skill_assessment', d_assess, 'assignments', d_assign,
      'submissions', d_subs, 'teaching_artifacts', d_arts, 'child_session_mints', d_mints, 'tutor_grants', d_grants,
      'memberships', d_mem, 'channel_members', d_chmem, 'derivation_outbox', d_outbox, 'subject_events', d_subjevents, 'children', 1),
    'tombstoned', jsonb_build_object('authored_messages', t_msgs),
    'retained', jsonb_build_array('consent_ledger', 'audit_log', 'stripe_events', 'deletion_receipts'),
    'entitlement', v_ent);
  -- serialize receipt insertion so the hash chain stays strictly linear (no fork
  -- under concurrent deletes of different children)
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

-- ---- 9. complete_child_deletion: flip receipt once GoTrue user is gone (#2) ---
create or replace function public.complete_child_deletion(p_child_auth_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if p_child_auth_user_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  update public.deletion_receipts set status = 'completed', completed_at = now()
   where child_auth_user_id = p_child_auth_user_id and status = 'pending_auth_cleanup';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'completed', v_n);   -- idempotent (0 if already done)
end $$;
revoke all on function public.complete_child_deletion(uuid) from public, anon, authenticated;
grant execute on function public.complete_child_deletion(uuid) to service_role;

-- ---- 10. list_pending_auth_cleanup: reconciliation drain (#2, service-only) ---
create or replace function public.list_pending_auth_cleanup()
returns table (child_auth_user_id uuid, db_purged_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select child_auth_user_id, db_purged_at from public.deletion_receipts
   where status = 'pending_auth_cleanup' and child_auth_user_id is not null
   order by db_purged_at
$$;
revoke all on function public.list_pending_auth_cleanup() from public, anon, authenticated;
grant execute on function public.list_pending_auth_cleanup() to service_role;
