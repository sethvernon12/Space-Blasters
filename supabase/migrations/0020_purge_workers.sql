-- ============================================================================
-- 0020_purge_workers.sql — Slice B2: external-purge queue + the worker-facing
-- helpers that let a scheduled maintenance worker DRIVE the B3 mechanisms
-- (reconcile / retention / dormant) and purge external artifacts (Storage/CDN,
-- AI-provider) after a deletion. LOCAL ONLY, additive. Joins the B2 SEC-03 review.
--
-- Design:
--   * Every deletion enqueues its external purge via an AFTER-INSERT trigger on
--     deletion_receipts — so ALL deletion paths (child, account, dormant, PITR
--     replay) are covered without touching purge_child.
--   * The worker drains the queue (SKIP LOCKED), and reconciles GoTrue stragglers
--     for both child and account receipts. Retention/dormant/pending helpers live
--     in 0017/0019; this adds the account-side reconcile list.
--   * Storage/AI purge is a HOOK (Phase 4/5 uploads/AI aren't built) — the worker
--     mock-completes today; the queue rows are the durable, retriable record.
--
-- DEFINER HYGIENE: every function SECURITY DEFINER, set search_path='', schema-
-- qualified, EXECUTE service-only. Queue is service/definer-only (no client access).
-- ============================================================================

-- ---- external_purge_queue: one row per (deleted child, external kind) ----------
create table if not exists public.external_purge_queue (
  id         uuid primary key default gen_random_uuid(),
  child_id   uuid not null,                    -- plain (the child is deleted)
  kind       text not null check (kind in ('storage', 'ai')),
  status     text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts   int  not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (child_id, kind)
);
create index if not exists external_purge_queue_pending_idx on public.external_purge_queue (status, created_at);
alter table public.external_purge_queue enable row level security;
alter table public.external_purge_queue force row level security;
revoke all on public.external_purge_queue from public, anon, authenticated;   -- service/definer only

-- ---- enqueue on EVERY deletion receipt (covers all deletion paths) --------------
create or replace function public.enqueue_external_purge() returns trigger
language plpgsql set search_path = ''
as $$
begin
  insert into public.external_purge_queue (child_id, kind)
  values (new.child_id, 'storage'), (new.child_id, 'ai')
  on conflict (child_id, kind) do nothing;   -- idempotent (PITR replay re-inserts safely)
  return new;
end $$;
drop trigger if exists deletion_receipts_enqueue_purge on public.deletion_receipts;
create trigger deletion_receipts_enqueue_purge after insert on public.deletion_receipts
  for each row execute function public.enqueue_external_purge();

-- ---- claim_external_purge: the worker leases pending rows (SKIP LOCKED) ---------
create or replace function public.claim_external_purge(p_limit int default 50)
returns table (id uuid, child_id uuid, kind text)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
  update public.external_purge_queue q set attempts = q.attempts + 1, updated_at = now()
   where q.id in (
     select c.id from public.external_purge_queue c
      where c.status = 'pending' order by c.created_at limit greatest(coalesce(p_limit, 50), 1)
      for update skip locked)
  returning q.id, q.child_id, q.kind;
end $$;
revoke all on function public.claim_external_purge(int) from public, anon, authenticated;
grant execute on function public.claim_external_purge(int) to service_role;

create or replace function public.complete_external_purge(p_id uuid, p_ok boolean, p_error text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if p_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  update public.external_purge_queue
     set status = case when p_ok then 'done' else 'failed' end,
         last_error = case when p_ok then null else left(coalesce(p_error, 'error'), 500) end,
         updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.complete_external_purge(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.complete_external_purge(uuid, boolean, text) to service_role;

-- ---- list_pending_account_auth_cleanup: account-side GoTrue reconcile -----------
-- Parallel to list_pending_auth_cleanup (0018, child-side). Returns the parent +
-- its child auth ids so the worker can delete any straggler GoTrue users.
create or replace function public.list_pending_account_auth_cleanup()
returns table (account_receipt_id uuid, parent_auth_user_id uuid, child_auth_user_ids uuid[])
language plpgsql stable security definer set search_path = ''
as $$
begin
  return query
  select a.id, a.parent_auth_user_id,
         coalesce((select array_agg(dr.child_auth_user_id) from public.deletion_receipts dr
                   where dr.id = any(a.child_receipt_ids) and dr.child_auth_user_id is not null), '{}')
  from public.account_deletion_receipts a
  where a.status = 'pending_auth_cleanup' and a.parent_auth_user_id is not null
  order by a.db_purged_at;
end $$;
revoke all on function public.list_pending_account_auth_cleanup() from public, anon, authenticated;
grant execute on function public.list_pending_account_auth_cleanup() to service_role;
