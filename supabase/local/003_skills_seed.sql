-- ============================================================================
-- 003_skills_seed.sql — LOCAL STACK ONLY. The 23-skill taxonomy (reference
-- data), aligned to the real schema. Shared by the M1 capture seed and the M3
-- family setup. Idempotent. Never applied to DEV/PROD by this file (the taxonomy
-- is seeded there through the reviewed migration path).
-- ============================================================================
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
