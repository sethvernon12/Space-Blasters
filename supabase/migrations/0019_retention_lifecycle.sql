-- ============================================================================
-- 0019_retention_lifecycle.sql — Slice B3: retention lifecycle + one deletion path.
-- LOCAL ONLY, additive. Joins the B3 SEC-03 review before any DEV apply.
--
-- Closes the last structural gaps from the five-lens deletion review:
--   * RETENTION IS NOT FOREVER (#10 / COPPA 312.10): evidence rows (consent_ledger,
--     audit_log, deletion_receipts, stripe_events, deletion_attempts) are kept for
--     a DEFINED window then shredded. The numbers are an attorney input (LEG-05) —
--     this ships the MECHANISM with documented PLACEHOLDERS in `retention_policy`.
--   * ONE DELETION PATH EVER (#10): account deletion + dormant-family lifecycle both
--     route through the SAME `purge_child` kernel (via `purge_account`), never a
--     second bespoke path.
--   * PITR ANCHOR (#11): a receipt is only shreddable AFTER it is exported off-DB
--     (`receipt_exports`), so retention can never destroy the last replay source.
--
-- DEFINER HYGIENE: every function is SECURITY DEFINER, set search_path='',
-- schema-qualified, EXECUTE service-only. Immutable-table shredding reaches through
-- the ONE reviewed path via the `app.purge` tx-local GUC (0018).
-- ============================================================================

-- ---- 1. retention_policy: per-evidence-kind window (LEG-05 sets the numbers) --
create table if not exists public.retention_policy (
  evidence_kind  text primary key,
  retain_interval interval not null,
  note           text
);
alter table public.retention_policy enable row level security;
alter table public.retention_policy force row level security;
revoke all on public.retention_policy from public, anon, authenticated;   -- service/definer only
-- PLACEHOLDERS — NOT legal advice. LEG-05: the attorney sets the binding numbers
-- before any real family's evidence exists; do not treat these as final.
insert into public.retention_policy (evidence_kind, retain_interval, note) values
  ('consent_ledger',           interval '7 years',  'LEG-05 PLACEHOLDER — VPC consent record'),
  ('audit_log',                interval '7 years',  'LEG-05 PLACEHOLDER — child-data access log'),
  ('deletion_receipts',        interval '7 years',  'LEG-05 PLACEHOLDER — deletion proof (export first)'),
  ('account_deletion_receipts',interval '7 years',  'LEG-05 PLACEHOLDER — account deletion proof (export first)'),
  ('stripe_events',            interval '2 years',  'LEG-05 PLACEHOLDER — payment idempotency ledger'),
  ('deletion_attempts',        interval '30 days',  'LEG-05 PLACEHOLDER — rate-limit ledger, short')
on conflict (evidence_kind) do nothing;

-- ---- 2. receipt_exports: proof a receipt reached an off-DB sink (PITR anchor) --
create table if not exists public.receipt_exports (
  receipt_id  uuid primary key,   -- child OR account receipt id (uuid-unique across both)
  sink        text not null,
  exported_at timestamptz not null default now()
);
alter table public.receipt_exports enable row level security;
alter table public.receipt_exports force row level security;
revoke all on public.receipt_exports from public, anon, authenticated;   -- service/definer only

create or replace function public.mark_receipt_exported(p_receipt_id uuid, p_sink text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if p_receipt_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  insert into public.receipt_exports (receipt_id, sink) values (p_receipt_id, coalesce(p_sink, 'unknown'))
    on conflict (receipt_id) do nothing;   -- idempotent
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mark_receipt_exported(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_receipt_exported(uuid, text) to service_role;

-- ---- 3. account_deletion_receipts: immutable, hash-chained account-level proof --
create table if not exists public.account_deletion_receipts (
  id                 uuid primary key default gen_random_uuid(),
  parent_id          uuid not null,
  parent_auth_user_id uuid,
  deleting_actor     uuid not null,
  child_count        int not null,
  child_receipt_ids  uuid[] not null default '{}',
  disposition        jsonb not null,
  prev_receipt_hash  text,
  receipt_hash       text not null,
  status             text not null default 'pending_auth_cleanup'
                       check (status in ('pending_auth_cleanup', 'completed')),
  db_purged_at       timestamptz not null default now(),
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);
alter table public.account_deletion_receipts enable row level security;
alter table public.account_deletion_receipts force row level security;
revoke all on public.account_deletion_receipts from public, anon, authenticated;
grant select on public.account_deletion_receipts to authenticated;
drop policy if exists account_deletion_receipts_select on public.account_deletion_receipts;
create policy account_deletion_receipts_select on public.account_deletion_receipts for select to authenticated
  using (parent_id = auth.uid());
-- immutable except the one-way pending_auth_cleanup -> completed transition
create or replace function public.account_receipt_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purge', true) = 'on' then return old; end if;   -- retention shred only
    raise exception 'account_deletion_receipts is immutable';
  end if;
  if old.status = 'pending_auth_cleanup' and new.status = 'completed'
     and old.completed_at is null and new.completed_at is not null
     and new.id = old.id and new.parent_id = old.parent_id and new.receipt_hash = old.receipt_hash
     and new.disposition = old.disposition and new.child_count = old.child_count then
    return new;
  end if;
  raise exception 'account_deletion_receipts: only the auth-cleanup completion transition is permitted';
end $$;
drop trigger if exists account_deletion_receipts_guard on public.account_deletion_receipts;
create trigger account_deletion_receipts_guard before update or delete on public.account_deletion_receipts
  for each row execute function public.account_receipt_guard();

-- ---- 4. purge_account: the ONE path for a whole account (loops purge_child) -----
create or replace function public.purge_account(p_parent_id uuid, p_deleting_actor uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_parent_auth uuid; v_child record; v_res jsonb;
  v_child_receipts uuid[] := '{}'; v_child_auth uuid[] := '{}'; v_count int := 0;
  v_prev_hash text; v_hash text; v_disp jsonb; v_receipt public.account_deletion_receipts%rowtype;
  t_msgs int; d_ops int := 0; d_tmp int;
begin
  if p_parent_id is null or p_deleting_actor is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  perform set_config('lock_timeout', '5000', true);
  perform set_config('statement_timeout', '60000', true);

  -- idempotency: an existing account receipt => already purged; return it
  select * into v_receipt from public.account_deletion_receipts where parent_id = p_parent_id;
  if v_receipt.id is not null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'account_receipt_id', v_receipt.id,
      'parent_auth_user_id', v_receipt.parent_auth_user_id, 'child_auth_user_ids', v_child_auth,
      'status', v_receipt.status); end if;

  perform set_config('app.purge', 'on', true);

  -- (a) purge EVERY child through the SAME kernel (never a second path)
  for v_child in select id, auth_user_id from public.children where parent_id = p_parent_id order by created_at loop
    v_res := public.purge_child(v_child.id, p_parent_id, p_deleting_actor);
    if not (v_res->>'ok')::boolean then
      -- a legal hold (or any child failure) blocks the whole account deletion — fail loud
      return jsonb_build_object('ok', false, 'error', coalesce(v_res->>'error', 'child_purge_failed'), 'child_id', v_child.id);
    end if;
    v_child_receipts := v_child_receipts || (v_res->>'receipt_id')::uuid;
    if v_child.auth_user_id is not null then v_child_auth := v_child_auth || v_child.auth_user_id; end if;
    v_count := v_count + 1;
  end loop;

  -- (b) tombstone the PARENT's own authored messages in shared channels
  update public.events set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{body}', to_jsonb('[removed: account deleted]'::text))
   where kind = 'message' and author_actor_id = p_parent_id;
  get diagnostics t_msgs = row_count;

  -- (c) delete the parent's OPERATIONAL rows (evidence — consent_ledger/audit_log
  --     — is RETAINED under retention_policy, not deleted here)
  delete from public.entitlements       where parent_id = p_parent_id;             get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.pending_children   where parent_id = p_parent_id;             get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.deletion_attempts  where parent_id = p_parent_id;             get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.child_session_mints where parent_id = p_parent_id;            get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.suppressions       where actor_id = p_parent_id;              get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.tutor_grants       where tutor_id = p_parent_id;              get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.memberships        where member_actor_id = p_parent_id;       get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.channel_members    where member_actor_id = p_parent_id;       get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  delete from public.derivation_outbox  where member_actor_id = p_parent_id;       get diagnostics d_tmp = row_count; d_ops := d_ops + d_tmp;
  -- NOTE (deferred, B4): groups the parent CREATED are left intact — deleting a
  -- shared group would cascade OTHER families' data; family-group disposition +
  -- ownership reassignment is a B4 concern. Parent-authored content is tombstoned.

  -- the parent's GoTrue user id IS children.parent_id (the Google login)
  v_parent_auth := p_parent_id;

  -- (d) hash-chained account receipt (chains across BOTH receipt tables)
  v_disp := jsonb_build_object('children_purged', v_count, 'child_receipts', to_jsonb(v_child_receipts),
    'parent_ops_deleted', d_ops, 'parent_messages_tombstoned', t_msgs,
    'retained', jsonb_build_array('consent_ledger', 'audit_log'));
  perform pg_advisory_xact_lock(hashtext('deletion_receipts_chain'));
  select h from (
    select receipt_hash h, created_at from public.deletion_receipts
    union all select receipt_hash, created_at from public.account_deletion_receipts
  ) x order by created_at desc, h desc limit 1 into v_prev_hash;
  v_hash := encode(extensions.digest(convert_to(
    coalesce(v_prev_hash, '') || '|acct|' || p_parent_id::text || '|' || coalesce(v_parent_auth::text, '') || '|' ||
    p_deleting_actor::text || '|' || v_count::text || '|' || v_disp::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.account_deletion_receipts (parent_id, parent_auth_user_id, deleting_actor, child_count,
    child_receipt_ids, disposition, prev_receipt_hash, receipt_hash, status)
  values (p_parent_id, v_parent_auth, p_deleting_actor, v_count, v_child_receipts, v_disp, v_prev_hash, v_hash, 'pending_auth_cleanup')
  returning * into v_receipt;

  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values (p_deleting_actor, 'account.delete', null, 'allow',
          jsonb_build_object('source', 'deletion', 'account_receipt_id', v_receipt.id, 'children', v_count, 'parent_auth_user_id', v_parent_auth));

  return jsonb_build_object('ok', true, 'account_receipt_id', v_receipt.id, 'parent_auth_user_id', v_parent_auth,
    'child_auth_user_ids', v_child_auth, 'status', 'pending_auth_cleanup', 'children_purged', v_count, 'receipt_hash', v_hash);
end $$;
revoke all on function public.purge_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_account(uuid, uuid) to service_role;

create or replace function public.complete_account_deletion(p_parent_auth_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if p_parent_auth_user_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  update public.account_deletion_receipts set status = 'completed', completed_at = now()
   where parent_auth_user_id = p_parent_auth_user_id and status = 'pending_auth_cleanup';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'completed', v_n);
end $$;
revoke all on function public.complete_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.complete_account_deletion(uuid) to service_role;

-- ---- 5. list_dormant_families: identify lapsed accounts for the lifecycle sweep -
-- (the SWEEP itself — routing each through purge_account — is a scheduled worker,
--  deferred to ops like the reconciliation drain; this is the identification.)
-- plpgsql (not sql) so the auth.users reference resolves at RUNTIME, not create
-- time — the ephemeral RLS-test DB mocks auth without a real auth.users table.
create or replace function public.list_dormant_families(p_cutoff timestamptz)
returns table (parent_id uuid, child_count int, last_activity timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  return query
  select c.parent_id, count(*)::int as child_count,
         greatest(
           coalesce(max(u.last_sign_in_at), 'epoch'::timestamptz),
           coalesce(max(s.started_at),      'epoch'::timestamptz),
           coalesce(max(a.created_at),       'epoch'::timestamptz)
         ) as last_activity
  from public.children c
  left join auth.users u on u.id = c.parent_id
  left join public.sessions s on s.child_id = c.id
  left join public.attempts a on a.child_id = c.id
  where c.parent_id is not null
  group by c.parent_id
  having greatest(
           coalesce(max(u.last_sign_in_at), 'epoch'::timestamptz),
           coalesce(max(s.started_at),      'epoch'::timestamptz),
           coalesce(max(a.created_at),       'epoch'::timestamptz)
         ) < p_cutoff;
end $$;
revoke all on function public.list_dormant_families(timestamptz) from public, anon, authenticated;
grant execute on function public.list_dormant_families(timestamptz) to service_role;

-- extend the 0018 deletion_receipt_guard so the authorized retention path (app.purge)
-- may DELETE a shreddable receipt — every other delete stays blocked (immutable).
create or replace function public.deletion_receipt_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purge', true) = 'on' then return old; end if;   -- retention shred only
    raise exception 'deletion_receipts is immutable';
  end if;
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

-- ---- 6. expire_retained_evidence: shred evidence past its retention window ------
-- Runs under app.purge (immutable-table bypass). SAFETY: a consent_ledger row still
-- referenced by a LIVE child is never shredded; a deletion receipt is shredded only
-- AFTER it has been exported off-DB (receipt_exports) — retention can never destroy
-- the last PITR replay source. Audited. Idempotent. (Scheduler deferred to ops.)
create or replace function public.expire_retained_evidence(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v jsonb := '{}'::jsonb; n int; iv interval;
begin
  perform set_config('app.purge', 'on', true);

  select retain_interval into iv from public.retention_policy where evidence_kind = 'consent_ledger';
  delete from public.consent_ledger cl where cl.created_at < p_now - iv
    and not exists (select 1 from public.children ch where ch.consent_id = cl.id);   -- protect live children
  get diagnostics n = row_count; v := v || jsonb_build_object('consent_ledger', n);

  select retain_interval into iv from public.retention_policy where evidence_kind = 'deletion_receipts';
  delete from public.deletion_receipts dr where dr.created_at < p_now - iv
    and exists (select 1 from public.receipt_exports re where re.receipt_id = dr.id);  -- exported-only
  get diagnostics n = row_count; v := v || jsonb_build_object('deletion_receipts', n);

  select retain_interval into iv from public.retention_policy where evidence_kind = 'account_deletion_receipts';
  delete from public.account_deletion_receipts ar where ar.created_at < p_now - iv
    and exists (select 1 from public.receipt_exports re where re.receipt_id = ar.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('account_deletion_receipts', n);

  select retain_interval into iv from public.retention_policy where evidence_kind = 'audit_log';
  delete from public.audit_log al where al.created_at < p_now - iv;
  get diagnostics n = row_count; v := v || jsonb_build_object('audit_log', n);

  select retain_interval into iv from public.retention_policy where evidence_kind = 'stripe_events';
  delete from public.stripe_events se where se.created_at < p_now - iv;
  get diagnostics n = row_count; v := v || jsonb_build_object('stripe_events', n);

  select retain_interval into iv from public.retention_policy where evidence_kind = 'deletion_attempts';
  delete from public.deletion_attempts da where da.created_at < p_now - iv;
  get diagnostics n = row_count; v := v || jsonb_build_object('deletion_attempts', n);

  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values ('00000000-0000-0000-0000-000000000000', 'retention.expire', null, 'allow',
          jsonb_build_object('source', 'retention', 'shredded', v));
  return jsonb_build_object('ok', true, 'shredded', v);
end $$;
revoke all on function public.expire_retained_evidence(timestamptz) from public, anon, authenticated;
grant execute on function public.expire_retained_evidence(timestamptz) to service_role;
