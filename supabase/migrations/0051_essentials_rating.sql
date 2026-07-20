-- ============================================================================
-- 0051_essentials_rating.sql — Phase 6 · Follow-Me · S2 (part 2). WEEKLY-ESSENTIALS RATINGS.
-- A rating is a 'rating' Event (append-only, immutable via events_immutable; a correction is a
-- NEW row, never an edit — DM-13 honest record). Leader ratings CARRY group_id for provenance,
-- BUT raw 'rating' events are DEFINER-ONLY-READ: events_select excludes 'rating' entirely, so a
-- co-parent in the same class (is_group_member) reads ZERO of another child's ratings. The SHOWN
-- essentials score = a DEFINER weekly AVERAGE over LEADER-authored ratings, recomputed from the
-- log (never stored), with a MIN-N floor (a single data point is not a robust average). The
-- parent rates too but is EXCLUDED from the shown average — surfaced only in the PARENT COCKPIT
-- as a perception-gap. "Latest wins" for a correction uses payload.rated_at = clock_timestamp()
-- (advances within a txn, unlike now()). can_view_child / is_group_member / is_group_leader
-- UNCHANGED. No follower/media/Stripe. Forward-only. DEV/local only.
-- ============================================================================

-- ---- (1) close the co-parent leak: 'rating' events are DEFINER-ONLY-READ (no client read path) ----
-- Extends the CURRENT hardened events_select (0011: the C2 fix — a child-subject event is readable
-- ONLY via can_view_child, NEVER via the group branch, which is narrowed to subject_child_id IS NULL)
-- with a leading kind<>'rating' guard. BOTH guards are independent and required: kind<>'rating' keeps
-- raw ratings out of even the can_view_child branch (definer-only-read); the C2 `subject_child_id is
-- null` keeps every OTHER child-subject group event (membership/removal/join) off the is_group_member
-- branch (the cross-family border). Non-rating events are byte-for-byte identical to 0011.
drop policy events_select on public.events;
create policy events_select on public.events for select to authenticated
  using (
    kind <> 'rating'
    and (
      (subject_child_id is not null and public.can_view_child(subject_child_id) and public.has_active_consent(subject_child_id))
      or (subject_child_id is null and group_id is not null and public.is_group_member(group_id))
    )
  );

-- ---- (2) submit_rating: a LEADER rates a child in their group; OR the PARENT rates their own child ----
create or replace function public.submit_rating(p_child_id uuid, p_group_id uuid, p_essential text, p_stars int)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_role text; v_event_id uuid;
        v_week text := to_char(date_trunc('week', now() at time zone 'UTC'), 'YYYY-MM-DD');  -- UTC-pinned week (TZ-independent across sessions)
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor_self() then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;   -- children never rate
  if p_child_id is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  if p_stars is null or p_stars < 1 or p_stars > 10 then return jsonb_build_object('ok', false, 'error', 'bad_stars'); end if;
  if not exists (select 1 from public.essentials e where e.id = p_essential and e.active) then return jsonb_build_object('ok', false, 'error', 'unknown_essential'); end if;
  if not public.has_active_consent(p_child_id) then return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;  -- never store data about a non-consented child
  if p_group_id is not null then
    if not public.is_group_leader(p_group_id, v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;     -- a leader of that group
    if not exists (select 1 from public.memberships m where m.group_id = p_group_id and m.member_child_id = p_child_id and m.active) then
      return jsonb_build_object('ok', false, 'error', 'not_in_group'); end if;                                                          -- the child is in that group
    v_role := 'leader';
  else
    if not public.is_my_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;               -- the child's own parent (group-agnostic)
    v_role := 'parent';
  end if;
  insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
  values ('rating', v_uid, p_child_id, p_group_id,
          jsonb_build_object('essential', p_essential, 'stars', p_stars, 'role', v_role,
                             'week', v_week, 'rated_at', clock_timestamp()))
  returning id into v_event_id;
  return jsonb_build_object('ok', true, 'event_id', v_event_id, 'role', v_role, 'week', v_week);
end $$;
revoke all on function public.submit_rating(uuid, uuid, text, int) from public, anon;
grant execute on function public.submit_rating(uuid, uuid, text, int) to authenticated;

-- ---- (3) essentials_score: the SHOWN weekly average over LEADER ratings (min-N floor), definer-only ----
-- Latest rating per (leader, essential) this week wins (correction-safe via rated_at); averaged across
-- them; surfaced ONLY when >= 2 leader ratings contribute, else NULL. MIN-N FLOOR = >= 2 leader ratings
-- (NOT necessarily 2 distinct leaders — a single-tutor class still surfaces once the tutor has rated >=2
-- essentials); this is interior-only, so it is acceptable now. NOTE (SEC-03): before S3 exposes this to
-- FOLLOWERS, redefine the floor over count(distinct author) >= 2 per FOL-7 truth-with-dignity. Definer-
-- only (revoked from authenticated) — reached solely via follow_me_aggregate, which enforces the gate.
create or replace function public.essentials_score(p_child_id uuid) returns numeric
language sql stable security definer set search_path = ''
as $$
  with latest as (
    select distinct on (e.author_actor_id, e.payload->>'essential') (e.payload->>'stars')::numeric as stars
    from public.events e
    where e.kind = 'rating' and e.subject_child_id = p_child_id
      and e.payload->>'role' = 'leader'
      and e.payload->>'week' = to_char(date_trunc('week', now() at time zone 'UTC'), 'YYYY-MM-DD')
    order by e.author_actor_id, e.payload->>'essential', (e.payload->>'rated_at')::timestamptz desc
  )
  select case when count(*) >= 2 then round(avg(stars), 1) else null end from latest
$$;
revoke all on function public.essentials_score(uuid) from public, anon, authenticated;   -- definer-only; surfaced via follow_me_aggregate

-- ---- (4) follow_me_aggregate: wire essentials_avg to the recomputed leader average (was NULL in S1) ----
create or replace function public.follow_me_aggregate(p_child_id uuid)
returns table (child_id uuid, first_name text, faithfulness_star int, essentials_avg numeric, practice_count int, skills_fluent int, signal_version text)
language sql stable security definer set search_path = ''
as $$
  with m as (
    select coalesce(sum(cm.attempts_count), 0) as practice, avg(cm.mastery) as avg_mastery,
           count(*) filter (where cm.mastery >= 0.85 and cm.attempts_count >= 5) as fluent
    from public.child_skill_mastery cm where cm.child_id = p_child_id
  )
  select p_child_id,
         (select ch.nickname from public.children ch where ch.id = p_child_id),
         greatest(1, least(10, round(10 * (0.6 * least(1.0, m.practice / 50.0) + 0.4 * coalesce(m.avg_mastery, 0)))))::int,
         public.essentials_score(p_child_id),                                            -- S2: the recomputed LEADER weekly average (min-N floored), or NULL
         m.practice::int, m.fluent::int, 'fm-v1'::text
  from m
  where (public.is_my_child(p_child_id) or public.can_view_child(p_child_id))
    and public.has_active_consent(p_child_id)                                            -- SEC-03: revocation drops the page (matches events_select consent gate)
    and m.practice > 0
$$;
-- grants preserved by create-or-replace (0049: revoke public/anon, grant authenticated)

-- ---- follow_me_growth / follow_me_milestones: add the same has_active_consent gate (revocation drops
-- every derived Follow-Me surface, not just the aggregate). Otherwise identical to 0049. ----
create or replace function public.follow_me_milestones(p_child_id uuid)
returns table (kind text, label text, skill_id text, achieved_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select 'fluency'::text, 'Reached fluency in ' || s.display_name, cm.skill_id, cm.last_correct_at
  from public.child_skill_mastery cm
  join public.skills s on s.id = cm.skill_id
  where cm.child_id = p_child_id
    and cm.mastery >= 0.85 and cm.attempts_count >= 5
    and (public.is_my_child(p_child_id) or public.can_view_child(p_child_id))
    and public.has_active_consent(p_child_id)
  order by cm.last_correct_at desc nulls last
$$;

create or replace function public.follow_me_growth(p_child_id uuid)
returns table (week_start date, practice int, accuracy_pct int)
language sql stable security definer set search_path = ''
as $$
  select date_trunc('week', a.created_at)::date,
         count(*)::int,
         round(100.0 * count(*) filter (where a.result = 'correct') / nullif(count(*), 0))::int
  from public.attempts a
  where a.child_id = p_child_id
    and a.result <> 'invalid'
    and (public.is_my_child(p_child_id) or public.can_view_child(p_child_id))
    and public.has_active_consent(p_child_id)
  group by 1
  order by 1
$$;

-- ---- (5) essentials_perception_gap: PARENT COCKPIT only — the parent's rating vs the leader avg ----
-- Per essential: the leader weekly average vs the parent's own rating (never on the follower page).
-- Fail-closed to the child's OWN parent (is_my_child AND not a child actor) → 0 rows for anyone else.
create or replace function public.essentials_perception_gap(p_child_id uuid)
returns table (essential text, label text, leader_avg numeric, parent_stars numeric, gap numeric)
language sql stable security definer set search_path = ''
as $$
  with lead as (
    select distinct on (e.author_actor_id, e.payload->>'essential')
           e.payload->>'essential' as essential, (e.payload->>'stars')::numeric as stars
    from public.events e
    where e.kind = 'rating' and e.subject_child_id = p_child_id and e.payload->>'role' = 'leader'
      and e.payload->>'week' = to_char(date_trunc('week', now() at time zone 'UTC'), 'YYYY-MM-DD')
    order by e.author_actor_id, e.payload->>'essential', (e.payload->>'rated_at')::timestamptz desc
  ),
  la as (select essential, round(avg(stars), 1) as avg_stars from lead group by essential),
  par as (
    select distinct on (e.payload->>'essential')
           e.payload->>'essential' as essential, (e.payload->>'stars')::numeric as stars
    from public.events e
    where e.kind = 'rating' and e.subject_child_id = p_child_id and e.payload->>'role' = 'parent'
      and e.payload->>'week' = to_char(date_trunc('week', now() at time zone 'UTC'), 'YYYY-MM-DD')
    order by e.payload->>'essential', (e.payload->>'rated_at')::timestamptz desc
  )
  select es.id, es.label, la.avg_stars, par.stars, (par.stars - la.avg_stars)
  from public.essentials es
  left join la  on la.essential  = es.id
  left join par on par.essential = es.id
  where es.active
    and public.is_my_child(p_child_id) and not public.is_child_actor_self()              -- PARENT-ONLY; never a leader / the follower page
    and public.has_active_consent(p_child_id)                                            -- SEC-03: no derived surface for a revoked child
  order by es.sort_order
$$;
revoke all on function public.essentials_perception_gap(uuid) from public, anon;
grant execute on function public.essentials_perception_gap(uuid) to authenticated;

-- ---- (6) weekly cadence via the existing requirement/to-do floor (NOT a new scheduler) ----
-- The existing maintenance worker calls this weekly; it creates 'requirement' to-do Events (idempotent
-- per week) reusing the requirement kind (0008). A LEADER to-do is class-level (subject_child_id NULL —
-- no per-child roster leak via events_select's group branch); a PARENT to-do is private (own child,
-- group_id NULL → only the parent's can_view_child branch). Worker/service-only.
create or replace function public.enqueue_weekly_rating_todos() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_week text := to_char(date_trunc('week', now()), 'YYYY-MM-DD'); v_n int := 0; v_r record;
begin
  for v_r in
    -- LEADER to-dos: one per (class/team leader, group) that has a consented child member
    select g.created_by as actor_id, g.id as group_id, null::uuid as child_id
    from public.groups g
    where g.purpose in ('class','team')
      and exists (select 1 from public.memberships m where m.group_id = g.id and m.member_child_id is not null and m.active and public.has_active_consent(m.member_child_id))
    union
    -- PARENT to-dos: one per (parent, own consented child)
    select c.parent_id, null::uuid, c.id
    from public.children c where c.parent_id is not null and public.has_active_consent(c.id)
  loop
    if not exists (
      select 1 from public.events e
      where e.kind = 'requirement' and e.author_actor_id = v_r.actor_id
        and e.group_id is not distinct from v_r.group_id
        and e.subject_child_id is not distinct from v_r.child_id
        and e.payload->>'requirement_key' = 'weekly_rating' and e.payload->>'week' = v_week
    ) then
      insert into public.events (kind, author_actor_id, subject_child_id, group_id, payload)
      values ('requirement', v_r.actor_id, v_r.child_id, v_r.group_id,
              jsonb_build_object('requirement_key', 'weekly_rating', 'status', 'assigned', 'week', v_week));
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'created', v_n, 'week', v_week);
end $$;
revoke all on function public.enqueue_weekly_rating_todos() from public, anon, authenticated;  -- worker/service only
