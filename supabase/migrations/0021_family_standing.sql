-- ============================================================================
-- 0021_family_standing.sql — Slice B4: FAMILY-level moderation/sanction state +
-- an add/delete soft-cap. LOCAL ONLY, additive. Joins the B4 SEC-03 review.
--
-- Two anti-abuse gaps from the five-lens review:
--   * SANCTION STATE AT THE FAMILY LEVEL (not per-child) — flag events are
--     child-subject and get hard-deleted with the child, so a sanctioned family
--     could delete + re-add a child (or delete + re-sign-up, same Google sub) to
--     reset its standing. `family_standing` is keyed to the PARENT and is NOT
--     touched by purge_child/purge_account, so standing SURVIVES deletion.
--   * ADD/DELETE SOFT-CAP per family/30d — bounds child add↔delete churn (evasion,
--     abuse) by capping ADDS (never deletes — deletion is a COPPA right) when a
--     family's recent op count is high.
--
-- DEFINER HYGIENE: every function SECURITY DEFINER, set search_path='', schema-
-- qualified, EXECUTE service-only unless a client legitimately needs read.
-- ============================================================================

-- ---- family_standing: parent-keyed, survives child + account deletion ----------
create table if not exists public.family_standing (
  parent_id   uuid primary key,                 -- the family head's auth uid (stable Google sub)
  flags       int  not null default 0,
  muted_until timestamptz,
  standing    text not null default 'good' check (standing in ('good', 'limited', 'suspended')),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.family_standing enable row level security;
alter table public.family_standing force row level security;
revoke all on public.family_standing from public, anon, authenticated;
grant select on public.family_standing to authenticated;   -- a parent sees their OWN standing (transparency)
drop policy if exists family_standing_select on public.family_standing;
create policy family_standing_select on public.family_standing for select to authenticated
  using (parent_id = auth.uid());
-- retention: keep moderation state a defined period past the account's end (LEG-05
-- placeholder). Operational data keyed to an adult uid — never child PII.
insert into public.retention_policy (evidence_kind, retain_interval, note) values
  ('family_standing', interval '3 years', 'LEG-05 PLACEHOLDER — family moderation/sanction state')
on conflict (evidence_kind) do nothing;
-- (Shredding family_standing is deferred to the retention sweep wiring; it is
--  low-volume and must not be shredded while the family is live — a future expire
--  pass gates on "no children AND an account_deletion_receipt AND past window".)

-- ---- family_of: resolve any actor to their family head (parent uid) -------------
create or replace function public.family_of(p_uid uuid) returns uuid
language sql stable security definer set search_path = ''
as $$ select coalesce((select parent_id from public.children where auth_user_id = p_uid limit 1), p_uid) $$;
revoke all on function public.family_of(uuid) from public, anon;
grant execute on function public.family_of(uuid) to authenticated;

-- ---- family_muted: is this actor's family currently muted/suspended? ------------
create or replace function public.family_muted(p_uid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.family_standing fs
    where fs.parent_id = public.family_of(p_uid)
      and (fs.standing = 'suspended' or (fs.muted_until is not null and fs.muted_until > now()))
  )
$$;
revoke all on function public.family_muted(uuid) from public, anon;
grant execute on function public.family_muted(uuid) to authenticated;

-- ---- record_family_flag: the moderation write (service-only) --------------------
-- Escalates standing with flag count; optionally mutes for N minutes. Idempotent
-- upsert on parent_id. Called by the moderation pipeline (server-side only).
create or replace function public.record_family_flag(p_parent_id uuid, p_reason text, p_mute_minutes int default 0)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_flags int; v_standing text;
begin
  if p_parent_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  insert into public.family_standing (parent_id, flags, muted_until, standing)
  values (p_parent_id, 1, case when coalesce(p_mute_minutes, 0) > 0 then now() + make_interval(mins => p_mute_minutes) else null end,
          'good')
  on conflict (parent_id) do update set
    flags = public.family_standing.flags + 1,
    muted_until = case when coalesce(p_mute_minutes, 0) > 0 then now() + make_interval(mins => p_mute_minutes)
                       else public.family_standing.muted_until end,
    updated_at = now()
  returning flags into v_flags;
  -- escalate standing on cumulative flags (5+ suspend, 3+ limited)
  v_standing := case when v_flags >= 5 then 'suspended' when v_flags >= 3 then 'limited' else 'good' end;
  update public.family_standing set standing = v_standing where parent_id = p_parent_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values ('00000000-0000-0000-0000-000000000000', 'family.flag', null, 'allow',
          jsonb_build_object('parent_id', p_parent_id, 'flags', v_flags, 'standing', v_standing, 'reason', left(coalesce(p_reason, ''), 200)));
  return jsonb_build_object('ok', true, 'flags', v_flags, 'standing', v_standing);
end $$;
revoke all on function public.record_family_flag(uuid, text, int) from public, anon, authenticated;
grant execute on function public.record_family_flag(uuid, text, int) to service_role;

-- ---- post_message (override 0013): block a muted/suspended family --------------
create or replace function public.post_message(p_channel_id uuid, p_context_ref_kind text, p_context_ref_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_group_id uuid; v_event_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if p_context_ref_kind is null or p_context_ref_id is null then return jsonb_build_object('ok', false, 'error', 'context_required'); end if;
  -- FAMILY-level sanction gate (B4): a muted/suspended family can't post, and it
  -- can't be reset by deleting/re-adding a child (standing is parent-keyed).
  if public.family_muted(v_uid) then return jsonb_build_object('ok', false, 'error', 'muted'); end if;
  select group_id into v_group_id from public.channels where id = p_channel_id;
  if v_group_id is null then return jsonb_build_object('ok', false, 'error', 'unknown_channel'); end if;
  if not exists (select 1 from public.channel_members cm where cm.channel_id = p_channel_id and cm.active
                 and (cm.member_actor_id = v_uid
                      or exists (select 1 from public.children ch where ch.id = cm.member_child_id and (ch.parent_id = v_uid or ch.auth_user_id = v_uid)))) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;
  insert into public.events (kind, author_actor_id, group_id, context_ref_kind, context_ref_id, payload)
  values ('message', v_uid, v_group_id, p_context_ref_kind, p_context_ref_id,
          jsonb_build_object('body', public.moderate_text(left(coalesce(p_body, ''), 2000))))
  returning id into v_event_id;
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end $$;

-- ---- family_child_ops_30d + create_pending_child override (add/delete soft-cap) -
create or replace function public.family_child_ops_30d(p_parent_id uuid) returns int
language sql stable security definer set search_path = ''
as $$
  select (select count(*) from public.consent_ledger where parent_id = p_parent_id and action = 'grant' and created_at > now() - interval '30 days')::int
       + (select count(*) from public.deletion_receipts where parent_id = p_parent_id and created_at > now() - interval '30 days')::int
$$;
revoke all on function public.family_child_ops_30d(uuid) from public, anon;
grant execute on function public.family_child_ops_30d(uuid) to authenticated;

-- override 0017 create_pending_child: same body + a family/30d add-cap (adds only).
create or replace function public.create_pending_child(p_nickname text, p_grade_band text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_nick text; v_token uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_nick := left(btrim(coalesce(p_nickname, '')), 40);
  if v_nick = '' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  -- B4 soft-cap: bound add↔delete churn per family/30d (10 add+delete ops). Deletes
  -- are never blocked (COPPA right); this caps NEW adds when a family is churning.
  if public.family_child_ops_30d(v_uid) >= 10 then
    return jsonb_build_object('ok', false, 'error', 'add_cap_reached'); end if;
  perform public.cleanup_pending_children();
  if (select count(*) from public.pending_children where parent_id = v_uid) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many_pending'); end if;
  insert into public.pending_children (parent_id, nickname, grade_band)
  values (v_uid, v_nick, nullif(left(coalesce(p_grade_band, ''), 8), ''))
  returning token into v_token;
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;
revoke all on function public.create_pending_child(text, text) from public, anon;
grant execute on function public.create_pending_child(text, text) to authenticated;
