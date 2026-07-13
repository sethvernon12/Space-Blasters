-- ============================================================================
-- 0034_grade_benchmark_corpus.sql — Phase 5 · 5f-a: the self-labeling benchmark corpus.
-- LOCAL ONLY, additive. The grading loop labels its own eval set: every HUMAN-CONFIRMED
-- handwriting grade already pairs a sanitized image (the upload) with a ground-truth read
-- (effective_read). This assembles those pairs to benchmark OUR OWN local reader.
--
-- Borders (founder ratification, 2026-07-13): the corpus is the OPEN INTERIOR of the
-- stewardship & strong-borders doctrine — our systems learn freely under enrollment consent,
-- NO per-family opt-out. But: it is INTERNAL-ONLY (service_role; NEVER a family caller, never
-- across a family boundary, never sent to any external vendor), AUDITED, and it trains/
-- benchmarks only our own local reader. Crucially it is REFERENCE-NOT-COPY — derived live
-- over the confirmed grade Events + their uploads — so purge_child (which deletes those
-- events + uploads) removes a departed child's contributions for free; the corpus can never
-- resurrect a deleted child's data.
--
-- DEFINER HYGIENE: SECURITY DEFINER, search_path='', schema-qualified, EXECUTE service-only.
-- ============================================================================
create or replace function public.benchmark_corpus(p_limit int default 10000)
returns jsonb language plpgsql security definer set search_path = ''  -- volatile: writes an audit row
as $$
declare v_out jsonb;
begin
  -- INTERNAL-ONLY tool: only the Academy's own benchmark harness (service_role) reaches this.
  -- (EXECUTE is revoked from every client role below — a family caller cannot invoke it.)
  select coalesce(jsonb_agg(row_obj order by created_at), '[]'::jsonb) into v_out
  from (
    select e.created_at,
      jsonb_build_object(
        'upload_id', (e.payload->>'upload_id'),
        'storage_path', u.storage_path,             -- the SANITIZED image (U3a re-encode) the grader read
        'ground_truth_read', (e.payload->>'effective_read')::int,   -- the human-verified answer = the label
        'skill_id', (e.payload->>'skill_id')
      ) as row_obj
    from public.events e
    join public.uploads u on u.id = (e.payload->>'upload_id')::uuid
    where e.kind = 'grade'
      and e.payload->>'source' = 'handwriting'
      and nullif(e.payload->>'effective_read', '') is not null
    limit greatest(coalesce(p_limit, 10000), 1)
  ) s;

  insert into public.audit_log (actor_id, action, child_id, decision, detail)
  values ('00000000-0000-0000-0000-000000000000', 'benchmark.corpus.read', null, 'allow',
          jsonb_build_object('source', 'benchmark', 'pairs', jsonb_array_length(v_out)));   -- aggregate, no per-child PII
  return jsonb_build_object('ok', true, 'pairs', v_out);
end $$;
revoke all on function public.benchmark_corpus(int) from public, anon, authenticated;   -- INTERNAL only
grant execute on function public.benchmark_corpus(int) to service_role;
