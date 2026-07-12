-- ============================================================================
-- 0026_uploads_jpeg_only.sql — Phase 4 · U3a. Uploads are STORED only as a fresh,
-- server-re-encoded JPEG. The upload Edge fn now DECODES JPEG/PNG (HEIC hard-rejected
-- server-side; the client converts first), applies a pre-decode dimension/megapixel
-- cap, downscales, and emits a clean JPEG — so PNG/HEIC are INPUT formats that never
-- reach storage as-is. Lock the bucket + record_upload to image/jpeg accordingly
-- (was jpeg/png/heic — that advertised formats the JPEG marker-scrubber couldn't
-- safely sanitize; SEC-U3 finding, 2026-07-11). LOCAL ONLY, additive. SEC-03 before DEV.
-- ============================================================================

-- the ONLY stored object type is a re-encoded JPEG.
update storage.buckets set allowed_mime_types = array['image/jpeg'] where id = 'uploads';

-- record_upload: identical to 0024 (adults-only, owner+consent, derived role, path
-- namespaced, exif_stripped stays false) EXCEPT content_type is locked to image/jpeg —
-- defense-in-depth so no direct call can record a png/heic row for a non-existent object.
create or replace function public.record_upload(
  p_child_id uuid, p_storage_path text, p_content_type text, p_byte_size int,
  p_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_role text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not public.can_write_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not public.has_active_consent(p_child_id) then return jsonb_build_object('ok', false, 'error', 'no_consent'); end if;
  if p_content_type <> 'image/jpeg' then return jsonb_build_object('ok', false, 'error', 'bad_type'); end if;  -- re-encoded JPEG only
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 10485760 then return jsonb_build_object('ok', false, 'error', 'bad_size'); end if;
  if p_storage_path is null or p_storage_path not like (p_child_id::text || '/%') then
    return jsonb_build_object('ok', false, 'error', 'bad_path');
  end if;
  v_role := case when exists (select 1 from public.children where id = p_child_id and parent_id = v_uid) then 'parent' else 'tutor' end;
  insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, note)
    values (p_child_id, v_uid, v_role, p_storage_path, 'image/jpeg', p_byte_size, nullif(btrim(coalesce(p_note, '')), ''))
    returning id into v_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'upload.record', p_child_id, 'allow', jsonb_build_object('upload_id', v_id, 'role', v_role, 'bytes', p_byte_size));
  return jsonb_build_object('ok', true, 'upload_id', v_id);
end $$;
revoke all on function public.record_upload(uuid, text, text, int, text) from public, anon;
grant execute on function public.record_upload(uuid, text, text, int, text) to authenticated;