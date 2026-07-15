-- ============================================================================
-- 0041_group_roster_visibility.sql — Phase 5 · Group Engine · S3a. LEADER-ROSTER
-- VISIBILITY. Purpose-dispatched roster reads: within-group adult communication is
-- PRESERVED (family/class/team/follower_circle adults see one another — we replace
-- GroupMe), while the SEC-REV-27 flat-peer-enumeration leak is CLOSED for the
-- ACADEMY group's adult rows (a plain parent no longer enumerates peer parents).
-- Child membership rows narrow to (own child OR the group's LEADER), so a plain
-- co-member parent can no longer enumerate other families' children while the leader
-- keeps the roster they need.
--
-- PURE NARROWING: the outer is_group_member() gate is retained on both policies, so
-- these rewrites can only ever RESTRICT what a caller sees vs. 0007 — never widen it.
-- role stays on the GRANT (memberships.role); is_group_leader is a DERIVED INDEX over
-- role × purpose × created_by, never a parallel authority store.
--
-- can_view_child (0001) and is_group_member (0007) are UNCHANGED — membership and
-- child-DATA disclosure remain two separate axes. The academy staff visibility branch
-- and the academy-wide child roster land in S3b (0042). Forward-only. DEV/local only.
-- MUST be security-reviewed (SEC-03) before any DEV/prod apply.
--
-- ACCEPTED ORACLE (SEC-REV-28 class): the new definer helpers (is_group_leader,
-- group_adults_are_open, channel_group) are grant-to-authenticated booleans/uuids over
-- arbitrary UUIDs — an authenticated caller can probe leadership/purpose/channel→group
-- linkage without membership. They return NO child PII and need an unguessable v4 UUID,
-- the same accepted low-risk class as has_active_consent (pinned at leak-test.mjs SEC-REV-28).
-- DEPENDENCY: is_group_leader trusts memberships.role (the GRANT) — this read policy is only
-- as sound as the join_group/role-assign write path + the cross-family write border (INFO-5).
-- ============================================================================

-- ---- is_group_leader — leadership as a DERIVED INDEX over the existing grant ----
-- The group's leader is its creator (owner) OR an active adult member holding the
-- leader role FOR THAT PURPOSE (tutor→class, coach→team, guardian/parent→family).
-- Academy leadership = the director = created_by (an academy 'tutor'/'coach' membership
-- is NOT an academy leader — they lead their own class/team sub-group). SECURITY
-- DEFINER to read memberships/groups without RLS recursion (mirrors is_group_member).
-- STRICTLY NARROWER than is_group_member by construction (every leader is a member;
-- plain members / guardians-only / child actors are not leaders).
create or replace function public.is_group_leader(p_group_id uuid, p_uid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.id = p_group_id
      and (
        g.created_by = p_uid
        or exists (
          select 1 from public.memberships m
          where m.group_id = g.id
            and m.member_actor_id = p_uid
            and m.member_child_id is null
            and m.active
            and (
                 (g.purpose = 'class'  and m.role = 'tutor')
              or (g.purpose = 'team'   and m.role = 'coach')
              or (g.purpose = 'family' and m.role in ('guardian','parent'))
            )
        )
      )
  )
$$;
revoke all on function public.is_group_leader(uuid, uuid) from public, anon;
grant execute on function public.is_group_leader(uuid, uuid) to authenticated;

-- ---- group_adults_are_open — the purposes where adults are mutually visible ----
-- family/class/team/follower_circle keep within-group adult visibility (communication;
-- we replace GroupMe). An ALLOWLIST, so a FUTURE purpose defaults to restrictive
-- (adult rows own-only) rather than silently leaking a new group's roster.
create or replace function public.group_adults_are_open(p_group_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.id = p_group_id
      and g.purpose in ('family','class','team','follower_circle')
  )
$$;
revoke all on function public.group_adults_are_open(uuid) from public, anon;
grant execute on function public.group_adults_are_open(uuid) to authenticated;

-- ---- channel_group — resolve a channel's group (definer; no channels RLS recursion)
-- Lets channel_members_select reuse the same purpose-dispatched predicates as
-- memberships_select without a recursive subquery through channels' own RLS.
create or replace function public.channel_group(p_channel_id uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select group_id from public.channels where id = p_channel_id
$$;
revoke all on function public.channel_group(uuid) from public, anon;
grant execute on function public.channel_group(uuid) to authenticated;

-- ---- memberships_select rewrite (purpose-dispatched; supersedes 0007:140-142) ----
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (
    public.is_group_member(group_id)                      -- outer gate UNCHANGED: non-members see nothing
    and (
      -- ADULT rows: your own row always; within family/class/team/follower_circle all
      -- adults are mutually visible (within-group communication). ACADEMY adult rows are
      -- own-only here (SEC-REV-27 closed for parents) — staff visibility arrives in S3b.
      (member_child_id is null and (
          member_actor_id = auth.uid()
          or public.group_adults_are_open(group_id)
      ))
      -- CHILD rows: consent-gated FIRST (a held/unconfirmed child never surfaces), then
      -- the child's own guardian/grant-holder OR the group's LEADER sees the full child
      -- roster. A plain co-member parent cannot enumerate other families' children.
      or (member_child_id is not null and public.has_active_consent(member_child_id) and (
          public.can_view_child(member_child_id)
          or public.is_group_leader(group_id, auth.uid())
      ))
    )
  );

-- ---- channel_members_select rewrite (mirrors memberships; supersedes 0007:156-158) --
drop policy if exists channel_members_select on public.channel_members;
create policy channel_members_select on public.channel_members for select to authenticated
  using (
    public.can_view_channel(channel_id)                   -- outer gate UNCHANGED
    and (
      (member_child_id is null and (
          member_actor_id = auth.uid()
          or public.group_adults_are_open(public.channel_group(channel_id))
      ))
      or (member_child_id is not null and public.has_active_consent(member_child_id) and (
          public.can_view_child(member_child_id)
          or public.is_group_leader(public.channel_group(channel_id), auth.uid())
      ))
    )
  );
