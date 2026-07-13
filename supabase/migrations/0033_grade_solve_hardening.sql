-- ============================================================================
-- 0033_grade_solve_hardening.sql — Phase 5 · 5e SEC-03 LOW: make grade_solve total.
-- LOCAL ONLY, additive. problem_dna is unconstrained jsonb (adult-authored on the
-- assignment); a non-numeric or overflowing operand made grade_solve throw, aborting
-- confirm_image_grade for that job (a self-inflicted, intra-family DoS on one's own
-- grading — never cross-family). Harden BEFORE the live VLM (5f): the solver now returns
-- NULL for any malformed/overflowing problem instead of throwing. A null solver answer
-- simply means "no agreement" — the automation-bias-resistant gate escalates and the human
-- corrects; the deterministic arbiter is never bypassed, only made total.
-- ============================================================================
create or replace function public.grade_solve(p_dna jsonb) returns int
language plpgsql immutable set search_path = ''
as $$
declare op text; a numeric; b numeric; v numeric;
begin
  op := p_dna->>'operator';
  -- operands must be JSON numbers; otherwise fall through / return null
  if op is not null and jsonb_typeof(p_dna->'a') = 'number' and jsonb_typeof(p_dna->'b') = 'number' then
    a := (p_dna->>'a')::numeric; b := (p_dna->>'b')::numeric;
    v := case op
      when 'add' then a + b
      when 'sub' then a - b
      when 'mul' then a * b
      when 'div' then case when b = 0 then null else a / b end
      else null end;
    if v is null or v < -2147483648 or v > 2147483647 then return null; end if;   -- guard int overflow
    return v::int;
  end if;
  if jsonb_typeof(p_dna->'correct_answer') = 'number' then                          -- trusted fallback (no operands)
    v := (p_dna->>'correct_answer')::numeric;
    if v < -2147483648 or v > 2147483647 then return null; end if;
    return v::int;
  end if;
  return null;
exception when others then return null;   -- TOTAL: any malformed input yields null, never a throw
end $$;
revoke all on function public.grade_solve(jsonb) from public, anon, authenticated;   -- called only from definer bodies
