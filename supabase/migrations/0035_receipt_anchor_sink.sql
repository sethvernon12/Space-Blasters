-- 0035_receipt_anchor_sink.sql — Phase 5 · Slice 1 (real export/purge sinks).
-- Makes "a deletion receipt is shreddable only after its off-DB export is CONFIRMED"
-- literally true, and closes three latent defects that were inert only while the sink
-- was a mock:
--   D2 — the shred gate was a BLACKLIST (receipt_exports.sink <> 'mock') and
--        mark_receipt_exported coalesced a null sink to 'unknown', so a null-sink bug or
--        any stub label satisfied shred WITHOUT a durable anchor. Here it becomes an
--        ALLOWLIST: only the CONFIRMED anchor label ('anchored', written by exportReceipt
--        after a read-after-write confirm) can ever enable shred; mock/unknown/null/'' can
--        NEVER. The direction stays fail-safe (a failed/unconfirmed export → over-
--        retention, never fail-open destruction).
--   D1 — the promised re-export retry did not exist. list_receipts_awaiting_export
--        enumerates receipts lacking a CONFIRMED anchor so the maintenance-worker can
--        re-drive the export automatically instead of stranding the receipt forever.
-- Plus the private anchor bucket the receipt-sink Edge fn writes (Storage = a durability
-- domain separate from the Postgres PITR timeline, so the anchor survives a DB shred).
-- Forward-only. DEV/local only — the PROD sink endpoint + key are config armed at the gate.

-- ---- private anchor bucket -------------------------------------------------------
-- Only opaque ids+hash ever land here (server-mediated by the service-role receipt-sink).
-- No storage.objects policy is created → every client (anon/authenticated) is denied
-- direct object access by default; only the service role reads/writes it.
insert into storage.buckets (id, name, public) values ('receipt-anchor', 'receipt-anchor', false)
  on conflict (id) do update set public = false;

-- ---- D2: mark_receipt_exported becomes an ALLOWLIST -------------------------------
-- Only a CONFIRMED durable off-DB export ('anchored', the label exportReceipt returns
-- after its read-after-write confirm) may be recorded. 'mock'/'unknown'/null/'' are
-- refused, so they can never satisfy the shred predicate below.
create or replace function public.mark_receipt_exported(p_receipt_id uuid, p_sink text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if p_receipt_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  if p_sink is distinct from 'anchored' then   -- allowlist: only a confirmed anchor
    return jsonb_build_object('ok', false, 'error', 'unconfirmed_sink');
  end if;
  -- idempotent; p_sink is guaranteed 'anchored' by the allowlist above, so a conflict
  -- UPGRADES any pre-existing non-'anchored' row (e.g. a legacy 'mock') to the confirmed
  -- anchor — only ever moves TOWARD 'anchored', never away (no fail-open).
  insert into public.receipt_exports (receipt_id, sink) values (p_receipt_id, p_sink)
    on conflict (receipt_id) do update set sink = 'anchored'
      where public.receipt_exports.sink is distinct from 'anchored';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mark_receipt_exported(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_receipt_exported(uuid, text) to service_role;

-- ---- D2: expire_retained_evidence shreds behind a CONFIRMED anchor ----------------
-- Redefinition of the 0019 shredder; the ONLY change vs 0019 is the two receipt
-- predicates: `re.sink <> 'mock'` (blacklist) → `re.sink = 'anchored'` (allowlist).
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

  -- a receipt is shreddable ONLY after a CONFIRMED off-DB export (sink = 'anchored') — a
  -- failed/mock/unconfirmed export must never let retention destroy the last replay source.
  select retain_interval into iv from public.retention_policy where evidence_kind = 'deletion_receipts';
  delete from public.deletion_receipts dr where dr.created_at < p_now - iv
    and exists (select 1 from public.receipt_exports re where re.receipt_id = dr.id and re.sink = 'anchored');
  get diagnostics n = row_count; v := v || jsonb_build_object('deletion_receipts', n);

  select retain_interval into iv from public.retention_policy where evidence_kind = 'account_deletion_receipts';
  delete from public.account_deletion_receipts ar where ar.created_at < p_now - iv
    and exists (select 1 from public.receipt_exports re where re.receipt_id = ar.id and re.sink = 'anchored');
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

-- ---- D1: list_receipts_awaiting_export (drives the worker's re-export drain) -------
-- Child + account receipts with NO CONFIRMED anchor yet, older than a small grace (so the
-- synchronous request-path export gets first crack before the drain re-tries). Service-
-- role only; the maintenance-worker re-invokes exportReceipt for each and marks on confirm.
create or replace function public.list_receipts_awaiting_export(
  p_limit int default 100, p_grace interval default interval '5 minutes')
returns table(receipt_id uuid, receipt_hash text, kind text, status text)
language sql stable security definer set search_path = ''
as $$
  select t.receipt_id, t.receipt_hash, t.kind, t.status from (
    select dr.id as receipt_id, dr.receipt_hash, 'child'::text as kind, dr.status, dr.created_at
      from public.deletion_receipts dr
      where dr.created_at < now() - p_grace
        and not exists (select 1 from public.receipt_exports re where re.receipt_id = dr.id and re.sink = 'anchored')
    union all
    select ar.id, ar.receipt_hash, 'account'::text, ar.status, ar.created_at
      from public.account_deletion_receipts ar
      where ar.created_at < now() - p_grace
        and not exists (select 1 from public.receipt_exports re where re.receipt_id = ar.id and re.sink = 'anchored')
  ) t order by t.created_at limit greatest(p_limit, 0)
$$;
revoke all on function public.list_receipts_awaiting_export(int, interval) from public, anon, authenticated;
grant execute on function public.list_receipts_awaiting_export(int, interval) to service_role;
