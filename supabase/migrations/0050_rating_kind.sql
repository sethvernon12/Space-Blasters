-- ============================================================================
-- 0050_rating_kind.sql — Phase 6 · Follow-Me · S2 (part 1). The 'rating' Event kind + the
-- CORE-6 essentials taxonomy (versioned reference DATA). SPLIT from 0051 because
-- ALTER TYPE ... ADD VALUE cannot be USED in the same transaction it is added — 0050 commits
-- the enum value, and 0051 (a later transaction) is free to use it. Forward-only. DEV/local only.
-- ============================================================================

alter type public.event_kind add value if not exists 'rating';

-- ---- essentials: the CORE 6, stored as VERSIONED reference DATA (tunable without a schema change) ----
-- Ratings store the essential id; the set can evolve (add/retire/relabel by DATA + a version bump)
-- and old ratings stay honestly recomputable. Reference data readable by any signed-in user (like
-- skills); NO client write path (migration/service only).
create table public.essentials (
  id           text primary key,          -- 'respect','effort','coachability','perseverance','kindness','integrity'
  label        text not null,
  description  text not null,
  sort_order   int  not null default 0,
  version      int  not null default 1,   -- bump to evolve the taxonomy; ratings reference the id
  active       boolean not null default true
);
alter table public.essentials enable row level security;
alter table public.essentials force  row level security;
revoke all on public.essentials from public, anon;                 -- belt-and-suspenders (convention); no client write
grant select on public.essentials to authenticated;
create policy essentials_read on public.essentials for select to authenticated using (true);

insert into public.essentials (id, label, description, sort_order) values
  ('respect',      'Respect',      'Honors people, rules, and property; courteous to coaches, teammates, and opponents.',   1),
  ('effort',       'Effort',       'Gives full, consistent effort; works hard whether or not it is easy or fun.',           2),
  ('coachability', 'Coachability', 'Receives feedback well; listens, adjusts, and applies correction without defensiveness.', 3),
  ('perseverance', 'Perseverance', 'Keeps going through difficulty, setbacks, and failure; finishes what they start.',       4),
  ('kindness',     'Kindness',     'Encourages and helps others; considerate of teammates, opponents, and newcomers.',       5),
  ('integrity',    'Integrity',    'Honest and fair; does the right thing even when no one is watching.',                    6)
on conflict (id) do nothing;
