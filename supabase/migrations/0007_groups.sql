-- ============================================================================
-- 0007_groups.sql — RM-07 primitives: Group + Membership + the unified Event log
-- + derived Channels, with RLS read rules. LOCAL ONLY, additive. MUST be
-- security-reviewed before any DEV/prod apply (SEC-03).
--
-- The five-primitive graph gains Group + Membership (DM-7, DER-01/02), the one
-- new append-only Event log for derivation-era kinds (DM-11 — attempts/consent/
-- audit/teaching stay specialized; see docs/BACKLOG.md), and Channels as derived
-- views of membership (COM-02/03). Read rules implement parent-in-the-loop
-- (DER-09) + family isolation + fail-closed consent on child-scoped rows.
-- Membership/channels/events are written ONLY via the RPCs/drain in 0008.
-- ============================================================================

create type public.group_purpose as enum ('family','class','team','academy','follower_circle');
create type public.event_kind as enum
  ('membership','requirement','attendance','completion','signature','message','flag','payment_intent','schedule','derivation_audit');

-- ---- Group (purpose is first-class; the engine dispatches on it) ----
create table public.groups (
  id         uuid primary key default gen_random_uuid(),
  purpose    public.group_purpose not null,
  name       text not null check (char_length(name) between 1 and 120),
  season     text,
  org_id     uuid,                     -- academy/org scoping seam (unwired)
  created_by uuid not null,            -- auth.users.id of the owning adult
  created_at timestamptz not null default now()
);

-- ---- Membership (a member is a child OR an adult — DM-1 deferral, exactly one)
create table public.memberships (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references public.groups(id) on delete cascade,
  member_child_id uuid references public.children(id) on delete cascade,
  member_actor_id uuid,                -- auth.users.id of an adult member/leader
  role            text not null default 'member',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  left_at         timestamptz,
  check ((member_child_id is not null) <> (member_actor_id is not null))
);
create unique index memberships_child_uniq on public.memberships (group_id, member_child_id) where member_child_id is not null;
create unique index memberships_actor_uniq on public.memberships (group_id, member_actor_id) where member_actor_id is not null;
create index memberships_group_idx on public.memberships (group_id);

-- ---- The one new append-only, authored Event log (DM-11 for derivation kinds)
create table public.events (
  id               uuid primary key default gen_random_uuid(),
  kind             public.event_kind not null,
  author_actor_id  uuid not null,      -- auth.users.id (or the group owner as system author)
  subject_child_id uuid references public.children(id) on delete cascade,
  group_id         uuid references public.groups(id) on delete cascade,
  context_ref_kind text,
  context_ref_id   uuid,
  payload          jsonb not null default '{}'::jsonb,   -- no PII beyond ids
  created_at       timestamptz not null default now(),
  -- COM-01 / DM-14: a message is unrepresentable without a context ref
  check (kind <> 'message' or (context_ref_kind is not null and context_ref_id is not null))
);
create index events_group_idx on public.events (group_id, created_at);
create index events_child_idx on public.events (subject_child_id, created_at);
create trigger events_immutable
  before update or delete on public.events
  for each row execute function public.forbid_mutation();

-- ---- Channels + members: DERIVED views of membership (COM-02/03) ----
create table public.channels (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.groups(id) on delete cascade,
  kind             text not null default 'thread',   -- announcement | thread
  name             text not null,
  context_ref_kind text,
  context_ref_id   uuid,
  created_at       timestamptz not null default now(),
  unique (group_id, name)
);
create table public.channel_members (
  id                   uuid primary key default gen_random_uuid(),
  channel_id           uuid not null references public.channels(id) on delete cascade,
  member_child_id      uuid references public.children(id) on delete cascade,
  member_actor_id      uuid,
  is_guardian_comember boolean not null default false,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  check ((member_child_id is not null) <> (member_actor_id is not null))
);
create unique index channel_members_child_uniq on public.channel_members (channel_id, member_child_id) where member_child_id is not null;
create unique index channel_members_actor_uniq on public.channel_members (channel_id, member_actor_id) where member_actor_id is not null;

-- ---- Suppressions (DER-10): opt-out is a row, never a deletion ----
create table public.suppressions (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null,
  target_kind text not null,        -- 'channel' | 'group' | 'notification'
  target_id   uuid not null,
  scope       text not null default 'notify',   -- notify | display
  created_at  timestamptz not null default now(),
  removed_at  timestamptz,
  unique (actor_id, target_kind, target_id, scope)
);

-- ---- read-rule helpers (SECURITY DEFINER to avoid RLS recursion) ----
-- Is the caller "in" the group? creator, adult member, a child member, OR the
-- guardian of a child member (DER-09 parent-in-the-loop).
create or replace function public.is_group_member(g uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.groups gr where gr.id = g and gr.created_by = auth.uid())
      or exists (select 1 from public.memberships m where m.group_id = g and m.active and m.member_actor_id = auth.uid())
      or exists (select 1 from public.memberships m
                 join public.children ch on ch.id = m.member_child_id
                 where m.group_id = g and m.active
                   and (ch.parent_id = auth.uid() or ch.auth_user_id = auth.uid()))
$$;
revoke all on function public.is_group_member(uuid) from public, anon;
grant execute on function public.is_group_member(uuid) to authenticated;

create or replace function public.can_view_channel(c uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.channels ch where ch.id = c and public.is_group_member(ch.group_id))
$$;
revoke all on function public.can_view_channel(uuid) from public, anon;
grant execute on function public.can_view_channel(uuid) to authenticated;

-- ---- RLS: default-deny + FORCE; family isolation + consent on child rows ----
alter table public.groups           enable row level security;  alter table public.groups           force row level security;
alter table public.memberships      enable row level security;  alter table public.memberships      force row level security;
alter table public.events           enable row level security;  alter table public.events           force row level security;
alter table public.channels         enable row level security;  alter table public.channels         force row level security;
alter table public.channel_members  enable row level security;  alter table public.channel_members  force row level security;
alter table public.suppressions     enable row level security;  alter table public.suppressions     force row level security;

-- groups: a member/guardian/creator reads; any adult may create a group they own.
create policy groups_select on public.groups for select to authenticated
  using (created_by = auth.uid() or public.is_group_member(id));
create policy groups_insert on public.groups for insert to authenticated
  with check (created_by = auth.uid());

-- memberships: the group's members/guardians read the roster; child rows require consent.
create policy memberships_select on public.memberships for select to authenticated
  using (public.is_group_member(group_id)
         and (member_child_id is null or public.has_active_consent(member_child_id)));
-- NO client insert/update/delete: join_group/leave_group RPCs (0008) only.

-- events: guardian reads events ABOUT their child (consent-gated); group members
-- read the group's events. (DER-09 read rule; no fan-out rows.)
create policy events_select on public.events for select to authenticated
  using (
    (subject_child_id is not null and public.can_view_child(subject_child_id) and public.has_active_consent(subject_child_id))
    or (group_id is not null and public.is_group_member(group_id))
  );
-- NO client insert/update/delete: RPCs/drain (0008) only; immutable trigger above.

create policy channels_select on public.channels for select to authenticated
  using (public.is_group_member(group_id));
create policy channel_members_select on public.channel_members for select to authenticated
  using (public.can_view_channel(channel_id)
         and (member_child_id is null or public.has_active_consent(member_child_id)));
-- NO client writes to channels/channel_members: drain (0008) only.

-- suppressions: a caller manages ONLY their own opt-outs.
create policy suppressions_select on public.suppressions for select to authenticated using (actor_id = auth.uid());
create policy suppressions_insert on public.suppressions for insert to authenticated with check (actor_id = auth.uid());
create policy suppressions_update on public.suppressions for update to authenticated using (actor_id = auth.uid()) with check (actor_id = auth.uid());

-- ---- GRANTS (anon gets nothing) ----
revoke all on public.groups, public.memberships, public.events, public.channels, public.channel_members, public.suppressions from public, anon;
grant select on public.memberships, public.events, public.channels, public.channel_members to authenticated;
grant select, insert on public.groups to authenticated;
grant select, insert, update on public.suppressions to authenticated;
