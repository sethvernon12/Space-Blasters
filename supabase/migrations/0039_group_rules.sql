-- 0039_group_rules.sql — Phase 5 · Group Engine · S1. Seed the class/team derivation
-- rules as DATA (DER-04). NO engine change: drain_derivations already dispatches
-- WHERE purpose = group.purpose (0008), so a class/team group derives correctly the
-- moment these rows exist. Purpose-scoped by construction — a team's athletics_waiver
-- requirement is keyed purpose='team' and is NEVER assigned to a class; a class's
-- enrollment_form is keyed purpose='class' and is never assigned to a team. (Requirement
-- rules match on role='member'; the drain's channel loop is role-agnostic.)
-- follower_circle is DELIBERATELY not seeded here — it is its own later slice ($1-anchor /
-- 10-star / hold-for-parent, MUST-FIX #6). Forward-only. DEV/local only. Idempotent on re-apply.
insert into public.derivation_rules (purpose, role, rule_kind, spec)
select v.purpose::public.group_purpose, v.role, v.rule_kind, v.spec
from (values
  ('class', 'member', 'channel',     jsonb_build_object('channel_name', 'General', 'kind', 'thread')),
  ('class', 'member', 'requirement', jsonb_build_object('requirement_key', 'enrollment_form')),
  ('team',  'member', 'channel',     jsonb_build_object('channel_name', 'Team', 'kind', 'thread')),
  ('team',  'member', 'requirement', jsonb_build_object('requirement_key', 'athletics_waiver'))
) as v(purpose, role, rule_kind, spec)
where not exists (
  select 1 from public.derivation_rules dr
  where dr.purpose = v.purpose::public.group_purpose and dr.rule_kind = v.rule_kind and dr.spec = v.spec
);
