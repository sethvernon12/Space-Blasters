-- 0036_pin_adult_helpers.sql — Phase 5 · Slice 3 (D-LOW1). Close a minor cross-adult
-- info leak: the adult-keyed helper functions each accept an arbitrary p_uid AND were
-- granted EXECUTE to `authenticated`, so one signed-in adult could probe ANOTHER adult's
-- family standing / stable subject / deletion churn / deletion status.
--
-- These helpers are only ever called INTERNALLY — by SECURITY DEFINER functions
-- (post_message, create_pending_child, record_family_flag, family_muted, the academy
-- redemption RPC), which run as the owner, or by RLS policies passing auth.uid(). No client
-- path calls them with someone else's uid. Fix, per data-borders (cross-family isolation):
--   * family_of / family_muted / family_child_deletes_30d / stable_subject: REVOKE the
--     `authenticated` grant. Definer callers run as owner (unaffected); no client path
--     exists, so this removes the probe surface entirely.
--   * actor_is_deleted: MUST stay callable by `authenticated` (the suppressions/groups
--     zombie-write RLS policies evaluate it as the querying role), so PIN it to auth.uid() —
--     it now reports ONLY the calling actor's own deletion status; a cross-uid probe → false.
-- Forward-only. DEV/local only. No behavior change to any legitimate path.

-- ---- revoke the authenticated grant on the definer-only adult-keyed helpers ----
revoke execute on function public.family_of(uuid) from authenticated;
revoke execute on function public.family_muted(uuid) from authenticated;
revoke execute on function public.family_child_deletes_30d(uuid) from authenticated;
revoke execute on function public.stable_subject(uuid) from authenticated;

-- ---- pin actor_is_deleted to the calling actor (the RLS policies pass auth.uid()) ----
create or replace function public.actor_is_deleted(p_uid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  -- reports ONLY the caller's own deletion tombstone; a cross-uid probe returns false so
  -- one actor can never learn whether another was deleted. The suppressions/groups RLS
  -- zombie-write guards call this as actor_is_deleted(auth.uid()), so their behavior is kept.
  select p_uid = auth.uid()
     and exists (select 1 from public.deletion_receipts where child_auth_user_id = auth.uid())
$$;
revoke all on function public.actor_is_deleted(uuid) from public, anon;
grant execute on function public.actor_is_deleted(uuid) to authenticated;
