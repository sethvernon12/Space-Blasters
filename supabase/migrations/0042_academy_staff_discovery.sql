-- ============================================================================
-- 0042_academy_staff_discovery.sql — Phase 5 · Group Engine · S3b. ACADEMY STAFF
-- DISCOVERY. Two things, both name-only, both leaving can_view_child pristine:
--   (1) a parent sees EVERY academy staff member (to pick a leader), and academy
--       staff see the academy's adults incl. parent connections — via is_academy_staff
--       branches ADDED to the roster policies (SEC-REV-27 stays closed for parents);
--   (2) academy_child_roster(academy) — a staff member looks up the academy-wide
--       child roster by NICKNAME + parent connection to ADD a child to the group they
--       lead. This is the SECOND child surface (the leader's "who's in my group" lives
--       in memberships via is_group_leader, 0041; this is "who in the academy could I
--       add"). Both expose NAME ONLY — never work. Work still requires a tutor_grant,
--       and a leader-initiated add's grant waits on the PARENT's confirmation (S4/S5).
--
-- SAFEGUARD (identity-proof doctrine): is_academy_staff gates on a COMPLETED
-- BACKGROUND CHECK, not just the role label — because academy_child_roster exposes
-- every enrolled child's name to that staff member. The clearance binding surface
-- (academy_staff_clearances) is created here and the gate is ENFORCED structurally.
-- No clearance rows are written in DEV yet: the ACADEMY's operational background-check
-- process writing real clearances is a PRE-REAL-FAMILIES LAUNCH GATE
-- ("academy staff background-check enforced"). The director (created_by) is the trust
-- root (Academy-controlled trust) and is not gated on a clearance row.
--
-- Depends on 0041 (is_group_leader, group_adults_are_open, channel_group). Forward-only.
-- DEV/local only. MUST be security-reviewed (SEC-03) before any DEV/prod apply.
--
-- ACCEPTED ORACLE (SEC-REV-28 class): is_academy_staff / has_completed_background_check are
-- grant-to-authenticated booleans over arbitrary (academy, uid) pairs — a caller can probe
-- "is uid X cleared staff at academy Y?" without membership. They return NO child data (only
-- an adult-staff boolean over UUIDs the caller already holds), the accepted low-risk class.
-- LAUNCH-GATE (SHOULD-FIX 1): the definer read of the FORCE-RLS clearance table below follows
-- the SAME owner-bypasses-RLS pattern as has_active_consent reading FORCE-RLS children (0006)
-- and is_group_member reading memberships (0007) — battle-tested on the hosted stack. Still,
-- before real families, write one real clearance in hosted DEV and assert
-- has_completed_background_check returns TRUE there (it fails CLOSED if the owner ever lacks
-- BYPASSRLS — staff access breaks, no leak). This is part of "academy staff background-check enforced".
-- ============================================================================

-- ---- clearance binding surface (adult-keyed; NOT child data) ----
-- Records a completed background check for a staff adult, scoped to ONE academy
-- (Academy-controlled trust). Written out-of-band by the Academy's verified process;
-- NEVER by a client. Deny-by-default: RLS enabled+forced with ZERO client policies,
-- read only through the SECURITY DEFINER predicates below. Adult account-deletion
-- cleanup rides with the account-deletion machinery (this table holds no child data;
-- on academy-group delete it cascades).
create table public.academy_staff_clearances (
  id               uuid primary key default gen_random_uuid(),
  academy_group_id uuid not null references public.groups(id) on delete cascade,
  actor_id         uuid not null,                       -- auth.users.id of the staff adult
  check_kind       text not null default 'background_check',
  completed_at     timestamptz,                         -- NULL = pending / not yet cleared
  revoked_at       timestamptz,                         -- set on revocation (clearance lapses)
  created_at       timestamptz not null default now(),
  unique (academy_group_id, actor_id, check_kind)
);
alter table public.academy_staff_clearances enable row level security;
alter table public.academy_staff_clearances force  row level security;
-- NO policies: deny-by-default (service/definer-only). No client insert/update/delete/select.
revoke all on public.academy_staff_clearances from public, anon, authenticated;

-- ---- has_completed_background_check — the clearance predicate ----
create or replace function public.has_completed_background_check(p_academy_group_id uuid, p_actor_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.academy_staff_clearances cl
    where cl.academy_group_id = p_academy_group_id
      and cl.actor_id = p_actor_id
      and cl.check_kind = 'background_check'
      and cl.completed_at is not null
      and cl.revoked_at is null
  )
$$;
revoke all on function public.has_completed_background_check(uuid, uuid) from public, anon;
grant execute on function public.has_completed_background_check(uuid, uuid) to authenticated;

-- ---- is_academy_staff — a background-checked staff member of a specific academy ----
-- SEPARATES academy staff from standalone/independent leaders (a standalone class/team
-- leader is never is_academy_staff, so they can never read an academy roster). The
-- director (created_by) is the trust root; a tutor/coach/director membership must ALSO
-- carry a completed background check (the SAFEGUARD — role label alone is not enough).
create or replace function public.is_academy_staff(p_group_id uuid, p_uid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.id = p_group_id and g.purpose = 'academy'
      and (
        g.created_by = p_uid                              -- the director/owner: Academy-controlled trust root
        or (
          exists (
            select 1 from public.memberships m
            where m.group_id = g.id and m.member_actor_id = p_uid
              and m.member_child_id is null and m.active
              and m.role in ('tutor','coach','director')
          )
          and public.has_completed_background_check(g.id, p_uid)   -- SAFEGUARD: completed background check required
        )
      )
  )
$$;
revoke all on function public.is_academy_staff(uuid, uuid) from public, anon;
grant execute on function public.is_academy_staff(uuid, uuid) to authenticated;

-- ---- memberships_select — ADD the academy staff adult branches (supersedes 0041) ----
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (
    public.is_group_member(group_id)
    and (
      (member_child_id is null and (
          member_actor_id = auth.uid()
          or public.group_adults_are_open(group_id)
          or public.is_academy_staff(group_id, member_actor_id)   -- staff ROWS visible to every academy member (parent sees all staff)
          or public.is_academy_staff(group_id, auth.uid())        -- a staff VIEWER sees all adults (needs parent connections)
      ))
      or (member_child_id is not null and public.has_active_consent(member_child_id) and (
          public.can_view_child(member_child_id)
          or public.is_group_leader(group_id, auth.uid())
      ))
    )
  );

-- ---- channel_members_select — mirror the academy staff branches (supersedes 0041) --
drop policy if exists channel_members_select on public.channel_members;
create policy channel_members_select on public.channel_members for select to authenticated
  using (
    public.can_view_channel(channel_id)
    and (
      (member_child_id is null and (
          member_actor_id = auth.uid()
          or public.group_adults_are_open(public.channel_group(channel_id))
          or public.is_academy_staff(public.channel_group(channel_id), member_actor_id)
          or public.is_academy_staff(public.channel_group(channel_id), auth.uid())
      ))
      or (member_child_id is not null and public.has_active_consent(member_child_id) and (
          public.can_view_child(member_child_id)
          or public.is_group_leader(public.channel_group(channel_id), auth.uid())
      ))
    )
  );

-- ---- academy_child_roster — the name-for-lookup discovery surface ----
-- A background-checked academy staff member DISCOVERS the academy-wide pool of enrolled
-- children (NICKNAME + parent connection) to ADD a child to the group they lead.
-- ENROLLMENT-IS-CONSENT: a child is "in the academy" iff their guardian's family group is
-- enrolled in THIS academy (purpose='family', arena='academy', org_id=academy). NAME ONLY
-- — no work, no mastery, no attempts; can_view_child is neither called nor changed, so a
-- name here confers ZERO child-DATA. VOLATILE (audits every view; HARD RULE #7/#9 — the
-- audit row carries NO child PII, only WHO viewed WHICH academy). is_academy_staff-gated,
-- so a standalone leader / a plain parent / a cross-academy staff member gets nothing.
create or replace function public.academy_child_roster(p_academy_group_id uuid)
returns table (child_id uuid, nickname text, parent_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  if not public.is_academy_staff(p_academy_group_id, v_uid) then return; end if;  -- gate: cleared academy staff only
  -- audit the roster view (child-identity-adjacent access) — NO child PII in the row
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'academy.child_roster.view', null, 'allow',
            jsonb_build_object('academy_group_id', p_academy_group_id));
  return query
    select c.id, c.nickname, c.parent_id
    from public.children c
    where c.consent_id is not null                              -- enrollment-consent active (VPC recorded; revoked → consent_id null → excluded)
      -- ENROLLMENT is the authoritative signal: the child appears iff their guardian's family group
      -- is enrolled in THIS academy. A deleted account's children are already purged (gone from
      -- `children`); a de-enrolled/withdrawn family drops this join — so no separate deleted-guardian
      -- belt is needed (and account_deletion_receipts alone is not a purge, nor is actor_is_deleted
      -- the right predicate — it is pinned to auth.uid() and is about CHILD-actor deletion).
      -- DEPENDENCY (INFO-6): this join keys enrollment on fg.created_by = c.parent_id, and
      -- groups_insert (0007) forces created_by = auth.uid() — so an attacker who stands up a fake
      -- academy (created_by=self) still cannot forge an enrollment for ANOTHER family's child.
      -- Do not refactor this to a looser key without re-proving that border.
      and exists (
        select 1 from public.groups fg
        where fg.created_by = c.parent_id
          and fg.purpose = 'family'
          and fg.arena = 'academy'
          and fg.org_id = p_academy_group_id                    -- the family is enrolled in THIS academy
      );
end $$;
revoke all on function public.academy_child_roster(uuid) from public, anon;
grant execute on function public.academy_child_roster(uuid) to authenticated;
