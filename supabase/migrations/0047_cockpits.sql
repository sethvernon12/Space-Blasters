-- ============================================================================
-- 0047_cockpits.sql — Phase 5 · Group Engine · S7. COCKPIT COMPOSITION (the visible
-- READ side). Pure read composition over the existing RLS-scoped reads — NO write path,
-- NO policy change. can_view_child / can_write_child / is_group_member / is_group_leader
-- are UNCHANGED (these RPCs only READ them). The Cockpit Doctrine holds: every card is a
-- query, no cockpit owns a bespoke write path.
--
-- THE TWO AXES STAY SEPARATE (S3 roster vs S5b work):
--   ROSTER = who is in a group (is_group_leader / membership) — opaque ids + a name only where
--            the caller may see it; WORK = a child's mastery/attempts (can_view_child = a grant).
-- SF-1 AGGREGATION-LEAK GUARD (the established convention — pending_grades 0009:118 re-asserts
--   can_write_child per row): EVERY child-DATA cell RE-ASSERTS the per-child gate. A cockpit
--   RPC NEVER trusts a join, a group membership, or a roster row to imply work access — a
--   rostered child WITHOUT a grant is a roster entry only, never their work.
-- Forward-only. DEV/local only. MUST be SEC-03'd (with a per-RPC aggregation-leak probe).
-- ============================================================================

-- ---- coach_roster: the ROSTER facet — every child in the groups the caller LEADS ----
-- cockpit-follows-role: rows exist iff is_group_leader(group, caller). The child_id (roster
-- identity) comes from is_group_leader; the NICKNAME is gated to can_view_child (a grant) OR
-- is_academy_staff (the S3b academy name-lookup) — a grant-less standalone-led child stays an
-- opaque roster entry. has_work_access = can_view_child, so the cockpit knows which children it
-- may show work for.
create or replace function public.coach_roster()
returns table (group_id uuid, group_name text, purpose text, child_id uuid, nickname text, has_work_access boolean)
language sql stable security definer set search_path = ''
as $$
  select g.id, g.name, g.purpose::text, m.member_child_id,
         case when public.can_view_child(m.member_child_id)
                or (g.org_id is not null and public.is_academy_staff(g.org_id, auth.uid()))
              then (select ch.nickname from public.children ch where ch.id = m.member_child_id)
              else null end,
         public.can_view_child(m.member_child_id)
  from public.groups g
  join public.memberships m on m.group_id = g.id and m.member_child_id is not null and m.active
  where g.purpose in ('class','team')
    and public.has_active_consent(m.member_child_id)  -- F1: a held/unconfirmed/consent-REVOKED child never surfaces (matches memberships_select / academy_child_roster; HARD RULE #1)
    and public.is_group_leader(g.id, auth.uid())      -- cockpit-follows-role: only groups the caller LEADS
$$;
revoke all on function public.coach_roster() from public, anon;
grant execute on function public.coach_roster() to authenticated;

-- ---- coach_students_work: the WORK facet — ONLY for rostered children the caller can VIEW ----
-- SF-1 guard: the trailing can_view_child(m.member_child_id) is the whole point — a rostered
-- child WITHOUT an active grant is EXCLUDED (never a bare "all my group's children → their work"
-- join). Compact work summary (counts) per grant-held led-group child.
create or replace function public.coach_students_work()
returns table (child_id uuid, group_id uuid, attempts_count int, mastery_count int)
language sql stable security definer set search_path = ''
as $$
  select m.member_child_id, g.id,
         (select count(*)::int from public.attempts a where a.child_id = m.member_child_id),
         (select count(*)::int from public.child_skill_mastery cm where cm.child_id = m.member_child_id)
  from public.groups g
  join public.memberships m on m.group_id = g.id and m.member_child_id is not null and m.active
  where g.purpose in ('class','team')
    and public.has_active_consent(m.member_child_id)    -- F1 defense-in-depth (can_view_child already blocks non-consented work)
    and public.is_group_leader(g.id, auth.uid())        -- the caller LEADS the group
    and public.can_view_child(m.member_child_id)        -- SF-1: WORK only for children the caller holds a grant for
$$;
revoke all on function public.coach_students_work() from public, anon;
grant execute on function public.coach_students_work() to authenticated;

-- ---- parent_union: the union of EVERY group each of the parent's OWN children is in (KER-3) ----
-- Bounded by is_my_child (own children only; stricter than can_view_child) → another family's child
-- is structurally unreachable. The whole picture of THEIR children across all their groups (class/
-- team/academy roll up), with a per-child work summary (always viewable — own children).
create or replace function public.parent_union()
returns table (child_id uuid, nickname text, group_id uuid, group_name text, purpose text, attempts_count int, mastery_count int)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.nickname, g.id, g.name, g.purpose::text,
         (select count(*)::int from public.attempts a where a.child_id = c.id),
         (select count(*)::int from public.child_skill_mastery cm where cm.child_id = c.id)
  from public.children c
  join public.memberships m on m.member_child_id = c.id and m.active
  join public.groups g on g.id = m.group_id
  where public.is_my_child(c.id)                         -- SF-1: own children only (implies can_view_child)
$$;
revoke all on function public.parent_union() from public, anon;
grant execute on function public.parent_union() to authenticated;
