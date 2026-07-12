-- ============================================================================
-- 0027_uploads_retention.sql — Phase 4 · U4: re-aim uploads deletion to the
-- DEPARTURE / REQUEST / SCHEDULE model and wire the storage-OBJECT purge into the
-- existing deletion kernel. LOCAL ONLY, additive. Joins the U4 SEC-03 review.
--
-- Governed by the VALUE-CAPTURE PRINCIPLE (docs/SPEC.md §1, ratified 2026-07-11):
-- capture-and-retain is the DEFAULT; sensitivity governs PROTECTION strength, never
-- deletion speed. Deletion triggers are family DEPARTURE, a parental REQUEST, and the
-- post-departure retention SCHEDULE (LEG-06/LEG-12) — NEVER a while-enrolled timer.
--
-- What this migration does:
--   U4a  Drop the interim while-enrolled 30-day auto-delete (uploads.expires_at +
--        index) — a child's work is RETAINED while enrolled.
--   U4a+ Join uploads to the structural-completeness backstop (0018 #3): its FK to
--        children becomes ON DELETE RESTRICT (was CASCADE — it cascaded silently,
--        bypassing the backstop and the receipt). purge_child now deletes + COUNTS
--        the uploads rows, so the immutable receipt is honest about what left.
--   U4b  child_storage_purge_manifest(): the CATALOG reconcile — a read-only SELECT
--        over storage.objects (the catalog, NEVER backend enumeration; NEVER a SQL
--        DELETE) returning the deleted child's object keys + counts + legal-hold, so
--        the worker deletes exactly that child's counted set via the Storage API.
--   U4c  external_purge_queue.result + complete_external_purge(p_result): a durable
--        technical annex of each purge (objects_purged, decision). Off-DB receipt
--        ledger (receipt_exports) already exists (0019). reconcile_deletions_after_
--        restore(): the executable runbook step that re-drives external purge for
--        every deletion after a PITR restore, so a completed departure-deletion
--        SURVIVES a restore (re-applied, never resurrected).
--   U4c+ retention_policy placeholders for the two departure paths (LEG-12): explicit
--        delete-now (immediate, minus a records-law skeleton) vs passive lapse (a
--        grace/archive window). INERT documentation — expire_retained_evidence only
--        acts on the evidence kinds it names; these are attorney-set (LEG-05) slots.
--
-- DEFINER HYGIENE: every function SECURITY DEFINER, set search_path='', schema-
-- qualified, EXECUTE service-only. Storage deletion is API-ONLY in the worker; SQL
-- only ever READS storage.objects (the catalog).
-- ============================================================================

-- ---- U4a: drop the while-enrolled 30-day auto-delete timer -------------------
drop index if exists public.uploads_expiry_idx;
alter table public.uploads drop column if exists expires_at;

-- ---- U4a+: uploads joins the structural-completeness backstop (RESTRICT) ------
-- Was ON DELETE CASCADE (added in 0024, after 0018's backstop) — so it cascaded
-- silently and purge_child neither deleted nor counted it. Make it RESTRICT like
-- every other child-keyed DATA table, so a future table the kernel forgets FK-blocks
-- the final delete (loud), and purge_child owns the delete + the receipt count.
do $$
declare n text;
begin
  select conname into n from pg_constraint
    where conrelid = 'public.uploads'::regclass and contype = 'f'
      and confrelid = 'public.children'::regclass;
  if n is not null then execute format('alter table public.uploads drop constraint %I', n); end if;
  alter table public.uploads
    add constraint uploads_child_id_children_restrict
    foreign key (child_id) references public.children(id) on delete restrict;
end $$;

-- invitations.target_child_id (0023) was ON DELETE CASCADE — the SAME silent-cascade
-- gap as uploads, and the LAST child-keyed FK escaping the AC-6 backstop. Make it
-- RESTRICT too; purge_child deletes the child's invitation rows explicitly (below).
do $$
declare n text;
begin
  select conname into n from pg_constraint
    where conrelid = 'public.invitations'::regclass and contype = 'f'
      and confrelid = 'public.children'::regclass;
  if n is not null then execute format('alter table public.invitations drop constraint %I', n); end if;
  alter table public.invitations
    add constraint invitations_target_child_id_children_restrict
    foreign key (target_child_id) references public.children(id) on delete restrict;
end $$;

-- ---- U4b: the CATALOG reconcile — the deleted child's storage objects ---------
-- Read-only SELECT over storage.objects (Supabase's own catalog of stored objects)
-- scoped to exactly ONE child prefix. p_child is uuid-typed, so the prefix is always
-- exactly one UUID + '/' (a uuid can hold no LIKE metacharacter) — the prefix-shape
-- guard is enforced by the type at the boundary. Returns the object KEYS (so the
-- worker can delete them via the Storage API), the child's own object count (the
-- self-calibrating per-child breaker input), the whole-bucket total (the cross-bucket
-- backstop input), and the child's active legal-hold flag (defense-in-depth: never
-- purge under a hold, even if a queue row somehow exists). NEVER deletes anything.
create or replace function public.child_storage_purge_manifest(p_bucket text, p_child uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_prefix text; v_objects jsonb; v_child_count int; v_total int; v_held boolean;
begin
  if p_bucket is null or p_child is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  v_prefix := p_child::text || '/';                       -- exactly one uuid + '/', type-guarded
  select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb), count(*)::int
    into v_objects, v_child_count
    from storage.objects o
   where o.bucket_id = p_bucket and o.name like v_prefix || '%';
  select count(*)::int into v_total from storage.objects o where o.bucket_id = p_bucket;
  select exists (select 1 from public.legal_holds where child_id = p_child and released_at is null) into v_held;
  return jsonb_build_object('ok', true, 'prefix', v_prefix, 'objects', v_objects,
    'child_count', v_child_count, 'bucket_total', v_total, 'legal_hold', v_held);
end $$;
revoke all on function public.child_storage_purge_manifest(text, uuid) from public, anon, authenticated;
grant execute on function public.child_storage_purge_manifest(text, uuid) to service_role;

-- ---- U4a+: purge_child gains the uploads disposition (rows deleted + counted) --
-- Identical to 0018 §8 EXCEPT: it now hard-deletes + counts public.uploads (rows),
-- and records 'uploads' in disposition.deleted. Storage OBJECTS are not reachable
-- from SQL and are purged by the worker via the external_purge_queue (0020) that the
-- deletion_receipts trigger already fires. The hash is over each receipt's own
-- disposition, so adding a key affects only NEW receipts — the chain stays valid.
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
  delete from public.uploads where child_id = p_child_id;                     get diagnostics d_uploads = row_count;  -- rows (RESTRICT); OBJECTS purged by the worker
  delete from public.invitations where target_child_id = p_child_id;          get diagnostics d_inv = row_count;      -- child-targeted invites (RESTRICT)
  delete from public.child_skill_mastery where child_id = p_child_id;          get diagnostics d_mastery = row_count;
  delete from public.child_skill_misconception where child_id = p_child_id;    get diagnostics d_misc = row_count;
  delete from public.child_skill_assessment where child_id = p_child_id;       get diagnostics d_assess = row_count;
  delete from public.sessions where child_id = p_child_id;                     get diagnostics d_sessions = row_count;
  delete from public.assignments where child_id = p_child_id;                  get diagnostics d_assign = row_count;
  delete from public.child_session_mints where child_id = p_child_id;          get diagnostics d_mints = row_count;
  delete from public.tutor_grants where child_id = p_child_id;                 get diagnostics d_grants = row_count;
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
      'child_session_mints', d_mints, 'tutor_grants', d_grants, 'memberships', d_mem, 'channel_members', d_chmem,
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

-- ---- U4c: durable technical annex of each external purge ----------------------
alter table public.external_purge_queue add column if not exists result jsonb;

-- complete_external_purge gains p_result (the worker records objects_purged + the
-- breaker decision). Same retry/park semantics as 0020; 3-arg callers still resolve
-- (p_result defaults null).
drop function if exists public.complete_external_purge(uuid, boolean, text);
create or replace function public.complete_external_purge(p_id uuid, p_ok boolean, p_error text default null, p_result jsonb default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_attempts int; v_max constant int := 10;
begin
  if p_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select attempts into v_attempts from public.external_purge_queue where id = p_id;
  update public.external_purge_queue
     set status = case when p_ok then 'done'
                       when coalesce(v_attempts, 0) >= v_max then 'failed'
                       else 'pending' end,
         last_error = case when p_ok then null else left(coalesce(p_error, 'error'), 500) end,
         result = coalesce(p_result, result),
         updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'terminal', (not p_ok and coalesce(v_attempts, 0) >= v_max));
end $$;
revoke all on function public.complete_external_purge(uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_external_purge(uuid, boolean, text, jsonb) to service_role;

-- ---- U4c: reconcile_deletions_after_restore — the executable runbook step ------
-- Backups are INTENTIONAL (durability protects the child's history). After a PITR
-- restore, a completed departure-deletion must SURVIVE it: any storage object the
-- restore brought back must be re-deleted, never resurrected. This re-arms the
-- external-purge queue for EVERY deletion receipt (child + account children), so the
-- next worker pass re-drives the Storage/AI purge. Idempotent (already-gone objects
-- are a no-op), audited, service-only. Run it as the last step of the restore runbook.
create or replace function public.reconcile_deletions_after_restore()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  insert into public.external_purge_queue (child_id, kind)
  select dr.child_id, k.kind
    from public.deletion_receipts dr
    cross join (values ('storage'), ('ai')) as k(kind)
  on conflict (child_id, kind) do update
     set status = 'pending', attempts = 0, last_error = null, updated_at = now()
   where public.external_purge_queue.status <> 'pending';   -- re-arm done/failed to re-drive
  get diagnostics v_n = row_count;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values ('00000000-0000-0000-0000-000000000000', 'retention.restore_reconcile', null, 'allow',
          jsonb_build_object('source', 'restore', 'requeued', v_n));
  return jsonb_build_object('ok', true, 'requeued', v_n);
end $$;
revoke all on function public.reconcile_deletions_after_restore() from public, anon, authenticated;
grant execute on function public.reconcile_deletions_after_restore() to service_role;

-- ---- U4c+: retention_policy placeholders for the two departure paths (LEG-12) --
-- INERT documentation slots (expire_retained_evidence acts ONLY on the evidence kinds
-- it names — never these). They record the ratified posture as attorney-fillable data
-- (LEG-05 gate). NOT a while-enrolled timer; NOT yet wired to a grace-window sweep.
insert into public.retention_policy (evidence_kind, retain_interval, note) values
  ('child_work_enrolled',        interval '1000 years',
     'LEG-12 PLACEHOLDER — RETAINED while enrolled (value-capture §1); no while-enrolled deletion. Not shredded by expire_retained_evidence.'),
  ('child_work_departed_grace',  interval '90 days',
     'LEG-12 PLACEHOLDER — passive lapse (entitlement expired / dormant): grace/archive window so a returning family resumes where they left off, THEN deletion. Attorney-set.'),
  ('records_law_skeleton',       interval '3 years',
     'LEG-12 PLACEHOLDER — minimal attendance/hours/final-grade kept past an explicit delete-now request (the statutory floor). Attorney sets the exact minimal set + floor (LEG-05).')
on conflict (evidence_kind) do nothing;
