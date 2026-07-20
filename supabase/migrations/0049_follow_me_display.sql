-- ============================================================================
-- 0049_follow_me_display.sql — Phase 6 · Follow-Me · S1. THE THIN INTERIOR DISPLAY
-- (the safe first slice: interior-only — parent + trusted staff read the honest aggregate;
-- NO follower, NO $1-anchor/Stripe, NO media; non-crown-jewel).
--
-- Read-only DERIVED VIEWS over the EXISTING per-child projection: child_skill_mastery is the
-- DATA-3/4 event-sourced Beta(α,β) projection (drain-maintained, replay-verified). The headline
-- metrics are READ from that projection's own honest fields — attempts_count (monotonic,
-- mastery-counted) and the α/β point estimate — never recomputed from raw attempts each read.
-- This establishes the Follow-Me read hot-path now so the later crown-jewel slices (S3 follower /
-- S4 $1-anchor / S5 hosted media / S6 live) do not re-architect it.
--
-- Follows the coach_roster/parent_union definer-composition pattern (0047): SECURITY DEFINER,
-- search_path='', revoke public/anon + grant authenticated, and FAIL-CLOSED per child inside the
-- body — the SF-1 aggregation-leak guard: every function re-asserts (is_my_child OR can_view_child)
-- so a caller only ever reaches a child they may see in the interior. It emits ONLY whitelisted
-- rolled-up columns — the FOL-9 faithfulness STAR (never the raw mastery %/grades), essentials-avg
-- (NULL until S2 wires 'rating' events), an honest practice count, and a fluency count. An
-- individual incident (an attempts row: problem_text/result) is NEVER in a SELECT projection here
-- (column-allowlist, test-enforced across all functions). NO cross-child ranking / leaderboard,
-- EVER (each function is per-child or the caller's-own-children — no cross-family ordered list).
--
-- Truth-with-dignity is structural: the faithfulness star is weighted TOWARD faithfulness (effort)
-- so a hard season still shines (ONE_PAGE principle 6/7); the child's own view is growth-and-
-- celebration (positive milestones), never a bare low score, and no dark patterns (STU-7 / NFR-07).
-- HONEST NAMING: the full "mastered" claim gates on fluency + retention + transfer (CLAUDE.md
-- ARCHITECTURE) — those signals land in later phases, so S1 reports an INTERIM "fluency" proxy on
-- game evidence and deliberately does NOT say "mastered." Every emitted definition carries a
-- signal_version ('fm-v1') so the formula is versioned (DATA-4 spirit).
--
-- Auto-generate per enrolled athlete where upstream exists (enrollment-is-consent); an empty
-- aggregate → NO page; a thin-upstream group → no page. UNCHANGED: can_view_child /
-- can_write_child / is_group_member / is_group_leader (only READ). NO new table, NO write path,
-- NOTHING scoped 'followers'. Forward-only. DEV/local only.
-- ============================================================================

-- ---- follow_me_aggregate(child): the honest headline row, from the projection, fail-closed ----
create or replace function public.follow_me_aggregate(p_child_id uuid)
returns table (child_id uuid, first_name text, faithfulness_star int, essentials_avg numeric, practice_count int, skills_fluent int, signal_version text)
language sql stable security definer set search_path = ''
as $$
  with m as (
    select coalesce(sum(cm.attempts_count), 0)                                       as practice,      -- honest, monotonic, mastery-counted attempts (the projection's own field)
           avg(cm.mastery)                                                           as avg_mastery,   -- raw point estimate; NEVER emitted, only folded into the star
           count(*) filter (where cm.mastery >= 0.85 and cm.attempts_count >= 5)     as fluent         -- INTERIM proxy: strong on game evidence (full mastered-gating = fluency+retention+transfer, later)
    from public.child_skill_mastery cm
    where cm.child_id = p_child_id
  )
  select p_child_id,
         (select ch.nickname from public.children ch where ch.id = p_child_id),        -- first-name-only
         -- FOL-9 faithfulness star (fm-v1, tunable): 0.6·engagement + 0.4·accuracy → 1..10, weighted
         -- TOWARD faithfulness (effort) so a hard season still shines. NEVER the raw mastery %.
         greatest(1, least(10, round(10 * (0.6 * least(1.0, m.practice / 50.0) + 0.4 * coalesce(m.avg_mastery, 0)))))::int,
         null::numeric,                                                                 -- essentials_avg: wired in S2 ('rating' events)
         m.practice::int,
         m.fluent::int,
         'fm-v1'::text                                                                  -- signal formula version (the definition is versioned; DATA-4)
  from m
  where (public.is_my_child(p_child_id) or public.can_view_child(p_child_id))           -- FAIL-CLOSED interior gate (parent OR trusted staff)
    and m.practice > 0                                                                  -- empty aggregate → NO page (auto-generate only where real practice exists)
$$;
revoke all on function public.follow_me_aggregate(uuid) from public, anon;
grant execute on function public.follow_me_aggregate(uuid) to authenticated;

-- ---- my_follow_me_pages(): the caller's OWN children's auto-generated pages (no ranking) ----
-- No cross-child ranking/leaderboard: strictly the caller's own children (is_my_child); a child
-- with no upstream contributes no row (the lateral returns nothing → no auto-page).
create or replace function public.my_follow_me_pages()
returns table (child_id uuid, first_name text, faithfulness_star int, essentials_avg numeric, practice_count int, skills_fluent int, signal_version text)
language sql stable security definer set search_path = ''
as $$
  select f.* from public.children c
  cross join lateral public.follow_me_aggregate(c.id) f
  where public.is_my_child(c.id)
$$;
revoke all on function public.my_follow_me_pages() from public, anon;
grant execute on function public.my_follow_me_pages() to authenticated;

-- ---- follow_me_milestones(child): auto-detected POSITIVE milestones only, fail-closed ----
-- Honest + celebratory (reached fluency on a skill — the INTERIM proxy, NOT the full "mastered"
-- claim); NO loss-aversion streaks / dark patterns (STU-7 / NFR-07).
create or replace function public.follow_me_milestones(p_child_id uuid)
returns table (kind text, label text, skill_id text, achieved_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select 'fluency'::text, 'Reached fluency in ' || s.display_name, cm.skill_id, cm.last_correct_at
  from public.child_skill_mastery cm
  join public.skills s on s.id = cm.skill_id
  where cm.child_id = p_child_id
    and cm.mastery >= 0.85 and cm.attempts_count >= 5                                   -- honest, auto-detected, positive only (interim fluency proxy)
    and (public.is_my_child(p_child_id) or public.can_view_child(p_child_id))           -- FAIL-CLOSED
  order by cm.last_correct_at desc nulls last
$$;
revoke all on function public.follow_me_milestones(uuid) from public, anon;
grant execute on function public.follow_me_milestones(uuid) to authenticated;

-- ---- follow_me_growth(child): the growth trajectory — the SAME signal plotted over time ----
-- A WEEKLY AGGREGATE (week, practice count, accuracy %). Emits ONLY rolled-up columns — an
-- individual attempt (problem_text/result) is NEVER projected. Fail-closed. This is the one
-- inherently-historical query (the projection stores current state only); it stays aggregate-safe.
-- INTERIOR-ONLY NOTE (SEC-03): a small-n week (practice=1 → accuracy 0/100) can reveal a single
-- week's mistake. That is fine here — parent/staff already see granular detail — but the S3
-- FOLLOWER reuse of this hot-path MUST add a minimum-n floor / sparse-week suppression before any
-- follower-facing surface, per FOL-7 truth-with-dignity ("a single mistake never surfaced").
create or replace function public.follow_me_growth(p_child_id uuid)
returns table (week_start date, practice int, accuracy_pct int)
language sql stable security definer set search_path = ''
as $$
  select date_trunc('week', a.created_at)::date,
         count(*)::int,
         round(100.0 * count(*) filter (where a.result = 'correct') / nullif(count(*), 0))::int
  from public.attempts a
  where a.child_id = p_child_id
    and a.result <> 'invalid'                                                           -- exclude discard-quality (matches mastery-counted)
    and (public.is_my_child(p_child_id) or public.can_view_child(p_child_id))           -- FAIL-CLOSED
  group by 1
  order by 1
$$;
revoke all on function public.follow_me_growth(uuid) from public, anon;
grant execute on function public.follow_me_growth(uuid) to authenticated;
