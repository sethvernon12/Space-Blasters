-- ============================================================================
-- 002_capture_seed.sql — LOCAL STACK ONLY. Fresh, data-only inserts aligned to
-- the REAL current schema (0001 + 0002). NOT the stale space-blasters-test-world
-- seed. Never applied to DEV or PROD.
-- ============================================================================
-- Seeds exactly what the recorder round-trip needs and nothing more:
--   * the 23 skills (taxonomy) — required by attempts.skill_id FK + the RPC's
--     stage->skill resolution.
--   * one legacy player "RoundTrip" with bcrypt PIN 2468 (via extensions.crypt).
--   * one CONSENTED child linked to that player (children.legacy_player_id +
--     children.consent_id), so record_attempts' consent gate passes.
-- Opaque child_id (a uuid); no real names beyond a synthetic test nickname.
-- Idempotent: safe to re-run (on conflict do nothing / guarded).
-- ============================================================================

-- 23 skills from taxonomy (positions 0..22; category = the 13 coarse tags).
insert into public.skills (id, display_name, category, alt_categories, ccss_codes, grade_band, position) values
  ('add5','Add within 5','addition','{}','{K.OA.A.5}','K',0),
  ('sub5','Subtract within 5','subtraction','{}','{K.OA.A.5}','K',1),
  ('add10','Add within 10','addition','{}','{1.OA.C.6,K.OA.A.2}','1',2),
  ('sub10','Subtract within 10','subtraction','{}','{1.OA.C.6,K.OA.A.2}','1',3),
  ('make10','Make 10 (number bonds)','make-ten','{}','{K.OA.A.4,1.OA.C.6}','K',4),
  ('add20','Add within 20','add-to-20','{}','{2.OA.B.2,1.OA.C.6}','2',5),
  ('sub20','Subtract within 20','sub-to-20','{}','{2.OA.B.2,1.OA.C.6}','2',6),
  ('miss10','Missing number to 10','missing-number','{}','{1.OA.D.8,1.OA.B.4}','1',7),
  ('miss20','Missing number to 20','missing-number','{}','{1.OA.D.8}','1',8),
  ('add2d','2-digit + 1-digit','two-digit-add','{}','{1.NBT.C.4,2.NBT.B.5}','1',9),
  ('sub2d','2-digit − 1-digit','two-digit-sub','{}','{2.NBT.B.5}','2',10),
  ('add2d2d','2-digit + 2-digit','two-digit-both','{}','{2.NBT.B.5}','2',11),
  ('missBig','Missing number (bigger)','missing-number','{}','{1.OA.D.8}','2',12),
  ('mult2','Multiply by 2','multiplication','{}','{3.OA.C.7,3.OA.A.1}','3',13),
  ('mult510','Multiply by 5 & 10','multiplication','{}','{3.OA.C.7,3.OA.A.1}','3',14),
  ('multTo5','Times tables to 5','multiplication','{}','{3.OA.C.7}','3',15),
  ('multTo10','Times tables to 10','multiplication','{}','{3.OA.C.7}','3',16),
  ('multMiss','Missing factor (? × 5 = 20)','missing-factor','{}','{3.OA.A.4,3.OA.B.6}','3',17),
  ('mult2d','2-digit × 1-digit','two-digit-mult','{}','{4.NBT.B.5,3.NBT.A.3}','4',18),
  ('div2510','Divide by 2, 5, 10','division','{}','{3.OA.C.7,3.OA.A.2}','3',19),
  ('divTo10','Division facts','division','{}','{3.OA.C.7}','3',20),
  ('divMiss','Missing number (20 ÷ ? = 4)','missing-factor','{}','{3.OA.A.4,3.OA.B.6}','3',21),
  ('mixMD','Mixed × and ÷','multiplication','{division}','{3.OA.C.7}','3',22)
on conflict (id) do nothing;

-- One legacy player + one consented child (fixed uuids for a repeatable test).
do $$
declare
  v_player uuid;
  v_consent uuid;
  v_child uuid := '0a0a0a0a-0000-4000-8000-00000000c0de';   -- opaque child_id
  v_parent uuid := '0b0b0b0b-0000-4000-8000-00000000d00d';   -- synthetic parent uuid (no auth yet)
begin
  if not exists (select 1 from public.players where lower(name) = 'roundtrip') then
    insert into public.players (name, pin_hash, best_score, games_played, total_correct)
    values ('RoundTrip', extensions.crypt('2468', extensions.gen_salt('bf')), 0, 0, 0);
  end if;
  select id into v_player from public.players where lower(name) = 'roundtrip';

  if not exists (select 1 from public.children where legacy_player_id = v_player) then
    insert into public.children (id, parent_id, legacy_player_id, nickname, grade_band)
    values (v_child, v_parent, v_player, 'Test Pilot', '1');
    insert into public.consent_ledger (parent_id, child_id, action, method, policy_version)
    values (v_parent, v_child, 'grant', 'stripe_card_transaction', 'local-test')
    returning id into v_consent;
    update public.children set consent_id = v_consent where id = v_child;
  end if;
end $$;
