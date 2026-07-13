-- ============================================================================
-- 0030_grade_review.sql — Phase 5 · 5c: the read-only trust-signal path for the
-- automation-bias-resistant human gate. LOCAL ONLY, additive. Joins the 5c SEC-03 review.
--
-- list_grade_proposals(child) returns each PENDING proposal for the child WITH the
-- SYSTEM-DERIVED trust signals the gate uses to scale friction — NEVER the model's own
-- confidence:
--   * solver_answer / agreement — computed from the TRUSTED assigned problem (grade_jobs
--     .problem_dna) via the deterministic solver, NEVER from the image.
--   * detector_clean — the image passed the U3a server-side re-encode sanitizer
--     (uploads.exif_stripped, set by mark_upload_verified).
-- The model's confidence is returned too, but the UI labels it a self-report and does not
-- gate on it. can_view + consent gated (a view-only tutor may READ; confirm is can_write).
-- No new tables, no writes → AC-6 / purge unchanged.
-- ============================================================================
create or replace function public.list_grade_proposals(p_child_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if not public.can_view_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.children where id = p_child_id and consent_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;

  select coalesce(jsonb_agg(row_to_json_obj order by created_at desc), '[]'::jsonb) into v_out
  from (
    select p.created_at,
      jsonb_build_object(
        'id', p.id, 'upload_id', p.upload_id, 'skill_id', p.skill_id,
        'read_answer', p.read_answer, 'confidence', p.confidence, 'feedback', p.feedback,
        'provider', p.provider, 'model', p.model_version, 'status', p.status, 'created_at', p.created_at,
        -- SYSTEM trust signals (from the trusted problem, never the image):
        'solver_answer', public.grade_solve(j.problem_dna),
        'agreement', (p.read_answer is not distinct from public.grade_solve(j.problem_dna)),
        'detector_clean', coalesce(u.exif_stripped, false)
      ) as row_to_json_obj
    from public.grade_proposals p
    join public.grade_jobs j on j.id = p.job_id
    left join public.uploads u on u.id = p.upload_id
    where p.child_id = p_child_id and p.status = 'pending'
  ) s;
  return jsonb_build_object('ok', true, 'proposals', v_out);
end $$;
revoke all on function public.list_grade_proposals(uuid) from public, anon;
grant execute on function public.list_grade_proposals(uuid) to authenticated;
