-- 0037_child_actor_self.sql — Phase 5 · Slice 3b (D-LOW1 sibling: is_child_actor).
-- Close the is_child_actor(uuid) cross-family child-existence oracle WITHOUT weakening the
-- SEC-REV-13 belt and WITHOUT breaking the service-role adult-gate:
--   * add is_child_actor_self() — the param-less form that reports ONLY whether the CALLER is
--     a child (security definer so it can read children; granted authenticated). No arbitrary-
--     uid probe is possible.
--   * teaching_artifacts_insert (the only RLS policy caller) now uses is_child_actor_self() in
--     place of is_child_actor(auth.uid()) — identical admit/deny (the policy is evaluated as the
--     querying role, whose auth.uid() the self form reads).
--   * REVOKE the arbitrary-uid is_child_actor(uuid) from authenticated. Its remaining DB callers
--     (approve_grade / approve_assignment + the register_child / grant_consent SERVICE-ROLE
--     adult-gates) are all SECURITY DEFINER and run as owner, so they are unaffected — and
--     PINNING those to auth.uid() would have been WRONG (service-role auth.uid() is null, which
--     would silently defeat the "parent must be an adult" gate).
-- The three Edge Functions that called is_child_actor(p_uid=ownUid) as the authenticated caller
-- (delete-child, delete-account, create-consent-checkout) are switched to is_child_actor_self()
-- in the same change — self-checks, identical semantics.
-- Forward-only. DEV/local only. No behavior change to any legitimate path.

-- the CALLER's own child-status (no cross-uid probe); definer so it can read children.
create or replace function public.is_child_actor_self() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.children where auth_user_id = auth.uid()) $$;
revoke all on function public.is_child_actor_self() from public, anon;
grant execute on function public.is_child_actor_self() to authenticated;

-- teaching_artifacts_insert: SAME admit/deny as 0014; only the "never a child" belt term changes
-- from is_child_actor(auth.uid()) to the self form (identical when evaluated as the querying role).
drop policy if exists teaching_artifacts_insert on public.teaching_artifacts;
create policy teaching_artifacts_insert on public.teaching_artifacts
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and not public.is_child_actor_self()   -- 3b: self-check, never an arbitrary-uid probe (SEC-REV-13 belt)
    and (
      (author_role = 'parent' and public.is_my_child(child_id))
      or (author_role = 'tutor' and exists (
            select 1 from public.tutor_grants tg
            where tg.child_id = teaching_artifacts.child_id
              and tg.tutor_id = auth.uid() and tg.active and tg.can_write))
    )
  );

-- close the arbitrary-uid oracle: authenticated can no longer probe another uid's child-status.
-- All remaining DB callers are SECURITY DEFINER (run as owner) — unaffected by this revoke.
revoke execute on function public.is_child_actor(uuid) from authenticated;
