-- ============================================================================
-- 0008_derivation_engine.sql — RM-07 the ONE derivation engine (DER-03…DER-12).
-- LOCAL ONLY, additive. MUST be security-reviewed before any DEV/prod apply.
--
-- Membership change -> domain Event + idempotent outbox (same txn) -> a drain
-- worker fans out channels (+ guardian structural co-membership), requirement
-- Events, and schedule visibility, dispatching declarative rules on group
-- purpose. Fail-closed consent (held-pending), idempotent, auditable, reversible.
-- No portal/UI (seams only, EXT-1).
-- ============================================================================

-- ---- Rules are DATA, keyed (purpose × role × season) (DER-04) ----
create table public.derivation_rules (
  id         uuid primary key default gen_random_uuid(),
  purpose    public.group_purpose not null,
  role       text not null default 'member',
  season     text,                                  -- null = any season
  rule_kind  text not null check (rule_kind in ('channel','requirement','schedule')),
  spec       jsonb not null default '{}'::jsonb,     -- e.g. {"channel_name":"General"} / {"requirement_key":"waiver"}
  version    int not null default 1,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.derivation_rules enable row level security;  alter table public.derivation_rules force row level security;
create policy derivation_rules_read on public.derivation_rules for select to authenticated using (true); -- non-PII config
revoke all on public.derivation_rules from public, anon;
grant select on public.derivation_rules to authenticated;

-- ---- Idempotent outbox (DER-03); internal engine state — NO client access ----
create table public.derivation_outbox (
  id               uuid primary key default gen_random_uuid(),
  trigger_event_id uuid not null references public.events(id),
  kind             text not null check (kind in ('join','leave')),
  group_id         uuid not null references public.groups(id) on delete cascade,
  member_child_id  uuid references public.children(id) on delete cascade,
  member_actor_id  uuid,
  role             text not null default 'member',
  idempotency_key  text not null unique,
  status           text not null default 'pending' check (status in ('pending','held','done','reversed','error')),
  attempts         int not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz
);
alter table public.derivation_outbox enable row level security;  alter table public.derivation_outbox force row level security;
revoke all on public.derivation_outbox from public, anon, authenticated;   -- deny-all; drain (definer) only

-- ---- join_group / leave_group: membership + Event + outbox in ONE txn (DER-03)
create or replace function public.join_group(p_group_id uuid, p_member_child_id uuid, p_member_actor_id uuid, p_role text default 'member')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if (p_member_child_id is null) = (p_member_actor_id is null) then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  -- AUTHORIZE: the group owner, OR a parent enrolling their OWN child. (fail-closed)
  if not (v_group.created_by = v_uid
          or (p_member_child_id is not null and public.is_my_child(p_member_child_id))) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select id into v_membership_id from public.memberships
   where group_id = p_group_id
     and member_child_id is not distinct from p_member_child_id
     and member_actor_id is not distinct from p_member_actor_id;
  if v_membership_id is null then
    insert into public.memberships (group_id, member_child_id, member_actor_id, role, active)
    values (p_group_id, p_member_child_id, p_member_actor_id, p_role, true) returning id into v_membership_id;
  else
    update public.memberships set active = true, left_at = null, role = p_role where id = v_membership_id;
  end if;

  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('membership', v_uid, p_member_child_id, p_group_id,
          jsonb_build_object('action', 'join', 'role', p_role, 'membership_id', v_membership_id))
  returning id into v_event_id;

  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
  values (v_event_id, 'join', p_group_id, p_member_child_id, p_member_actor_id, p_role,
          'join:' || v_membership_id::text || ':' || v_event_id::text, 'pending');

  return jsonb_build_object('ok', true, 'membership_id', v_membership_id, 'event_id', v_event_id);
end $$;
revoke all on function public.join_group(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.join_group(uuid, uuid, uuid, text) to authenticated;

create or replace function public.leave_group(p_group_id uuid, p_member_child_id uuid, p_member_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups%rowtype;
  v_membership_id uuid;
  v_role text;
  v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_group'); end if;
  if not (v_group.created_by = v_uid
          or (p_member_child_id is not null and public.is_my_child(p_member_child_id))) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id, role into v_membership_id, v_role from public.memberships
   where group_id = p_group_id
     and member_child_id is not distinct from p_member_child_id
     and member_actor_id is not distinct from p_member_actor_id and active;
  if v_membership_id is null then return jsonb_build_object('ok', false, 'error', 'not_a_member'); end if;

  update public.memberships set active = false, left_at = now() where id = v_membership_id;
  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('membership', v_uid, p_member_child_id, p_group_id,
          jsonb_build_object('action', 'leave', 'membership_id', v_membership_id))
  returning id into v_event_id;
  insert into public.derivation_outbox (trigger_event_id, kind, group_id, member_child_id, member_actor_id, role, idempotency_key, status)
  values (v_event_id, 'leave', p_group_id, p_member_child_id, p_member_actor_id, coalesce(v_role, 'member'),
          'leave:' || v_membership_id::text || ':' || v_event_id::text, 'pending');
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;
revoke all on function public.leave_group(uuid, uuid, uuid) from public, anon;
grant execute on function public.leave_group(uuid, uuid, uuid) to authenticated;

-- ---- The drain worker (DER-03/05/06/11/12): exactly-once-in-effect, fail-closed
create or replace function public.drain_derivations() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.derivation_outbox%rowtype;
  v_group public.groups%rowtype;
  v_rule public.derivation_rules%rowtype;
  v_channel_id uuid;
  v_processed int := 0; v_held int := 0; v_reversed int := 0;
begin
  for v_row in select * from public.derivation_outbox where status = 'pending' for update skip locked loop
    select * into v_group from public.groups where id = v_row.group_id;

    -- CONSENT is a precondition (DER-11): a child-scoped derivation with missing
    -- consent is HELD-pending, never silently skipped or proceeded.
    if v_row.member_child_id is not null
       and not exists (select 1 from public.children where id = v_row.member_child_id and consent_id is not null) then
      update public.derivation_outbox set status = 'held', attempts = attempts + 1, last_error = 'no_consent' where id = v_row.id;
      v_held := v_held + 1;
      continue;
    end if;

    if v_row.kind = 'join' then
      -- CHANNELS (DER-05): ensure channels from rules; add member + guardian co-members
      for v_rule in select * from public.derivation_rules
        where purpose = v_group.purpose and rule_kind = 'channel' and active
          and (season is null or season = v_group.season) loop
        select id into v_channel_id from public.channels where group_id = v_row.group_id and name = (v_rule.spec->>'channel_name');
        if v_channel_id is null then
          insert into public.channels (group_id, kind, name)
          values (v_row.group_id, coalesce(v_rule.spec->>'kind', 'thread'), v_rule.spec->>'channel_name')
          returning id into v_channel_id;
        end if;
        if v_row.member_child_id is not null then
          insert into public.channel_members (channel_id, member_child_id, is_guardian_comember)
          select v_channel_id, v_row.member_child_id, false
          where not exists (select 1 from public.channel_members where channel_id = v_channel_id and member_child_id = v_row.member_child_id);
          -- COM-03: every guardian of the child is a STRUCTURAL co-member
          insert into public.channel_members (channel_id, member_actor_id, is_guardian_comember)
          select v_channel_id, ch.parent_id, true from public.children ch
          where ch.id = v_row.member_child_id and ch.parent_id is not null
            and not exists (select 1 from public.channel_members cm where cm.channel_id = v_channel_id and cm.member_actor_id = ch.parent_id);
        else
          insert into public.channel_members (channel_id, member_actor_id, is_guardian_comember)
          select v_channel_id, v_row.member_actor_id, false
          where not exists (select 1 from public.channel_members where channel_id = v_channel_id and member_actor_id = v_row.member_actor_id);
        end if;
      end loop;

      -- REQUIREMENTS (DER-06): assigned Events per matching rule (idempotent)
      for v_rule in select * from public.derivation_rules
        where purpose = v_group.purpose and rule_kind = 'requirement' and active
          and role = v_row.role and (season is null or season = v_group.season) loop
        insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
        select 'requirement', v_group.created_by, v_row.member_child_id, v_row.group_id,
               jsonb_build_object('requirement_key', v_rule.spec->>'requirement_key', 'status', 'assigned', 'rule_version', v_rule.version)
        where not exists (
          select 1 from public.events e where e.kind = 'requirement' and e.group_id = v_row.group_id
            and e.subject_child_id is not distinct from v_row.member_child_id
            and e.payload->>'requirement_key' = (v_rule.spec->>'requirement_key')
            and e.payload->>'status' = 'assigned');
      end loop;

      -- SCHEDULE (DER-07): no copy — membership makes the group schedule appear on
      -- the guardian calendar view (guardian_calendar()).
      update public.derivation_outbox set status = 'done', processed_at = now(), attempts = attempts + 1 where id = v_row.id;
      v_processed := v_processed + 1;

    else  -- 'leave' : compensating reversal (DER-12), history preserved
      update public.channel_members cm set active = false
        from public.channels c
       where c.id = cm.channel_id and c.group_id = v_row.group_id
         and cm.member_child_id is not distinct from v_row.member_child_id
         and cm.member_actor_id is not distinct from v_row.member_actor_id;
      insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
      select 'requirement', v_group.created_by, v_row.member_child_id, v_row.group_id,
             jsonb_build_object('requirement_key', e.payload->>'requirement_key', 'status', 'cancelled')
      from public.events e
      where e.kind = 'requirement' and e.group_id = v_row.group_id
        and e.subject_child_id is not distinct from v_row.member_child_id
        and e.payload->>'status' = 'assigned';
      update public.derivation_outbox set status = 'reversed', processed_at = now(), attempts = attempts + 1 where id = v_row.id;
      v_reversed := v_reversed + 1;
    end if;

    -- AUDIT (DER-12): a derivation_audit Event per processed item
    insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
    values ('derivation_audit', v_group.created_by, v_row.member_child_id, v_row.group_id,
            jsonb_build_object('outbox_id', v_row.id, 'trigger', v_row.kind));
  end loop;
  return jsonb_build_object('processed', v_processed, 'held', v_held, 'reversed', v_reversed);
end $$;
revoke all on function public.drain_derivations() from public, anon;
grant execute on function public.drain_derivations() to authenticated;   -- worker simulation; real deploy = scheduled worker

-- ---- guardian_calendar (DER-07 / SCH-02): derived union, never synced copies
create or replace function public.guardian_calendar() returns setof public.events
language sql stable security definer set search_path = ''
as $$
  select e.* from public.events e
  where e.kind = 'schedule'
    and e.group_id in (
      select m.group_id from public.memberships m
      join public.children ch on ch.id = m.member_child_id
      where m.active and (ch.parent_id = auth.uid() or ch.auth_user_id = auth.uid())
    )
$$;
revoke all on function public.guardian_calendar() from public, anon;
grant execute on function public.guardian_calendar() to authenticated;

-- ---- post_message (COM-01): a message is a context-welded Event; members only
create or replace function public.post_message(p_channel_id uuid, p_context_ref_kind text, p_context_ref_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_group_id uuid; v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if p_context_ref_kind is null or p_context_ref_id is null then return jsonb_build_object('ok', false, 'error', 'context_required'); end if;
  select group_id into v_group_id from public.channels where id = p_channel_id;
  if v_group_id is null then return jsonb_build_object('ok', false, 'error', 'unknown_channel'); end if;
  if not exists (select 1 from public.channel_members cm where cm.channel_id = p_channel_id and cm.active
                 and (cm.member_actor_id = v_uid
                      or exists (select 1 from public.children ch where ch.id = cm.member_child_id and (ch.parent_id = v_uid or ch.auth_user_id = v_uid)))) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;
  insert into public.events (kind, author_actor_id, group_id, context_ref_kind, context_ref_id, payload)
  values ('message', v_uid, v_group_id, p_context_ref_kind, p_context_ref_id, jsonb_build_object('body', left(p_body, 2000)))
  returning id into v_event_id;
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;
revoke all on function public.post_message(uuid, text, uuid, text) from public, anon;
grant execute on function public.post_message(uuid, text, uuid, text) to authenticated;
