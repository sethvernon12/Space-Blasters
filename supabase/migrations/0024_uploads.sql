-- ============================================================================
-- 0024_uploads.sql — Phase 4 · U1: uploads (photographed child work) storage +
-- schema. LOCAL ONLY, additive. MUST pass SEC-03 + the cross-family isolation e2e
-- before any DEV/prod apply.
--
-- Scope of U1 = the SERVER FOUNDATION: a private Storage bucket (locked — no client
-- object access; reads/writes go through server-generated short-lived signed URLs
-- only) + the `uploads` table + child-scoped RLS + the two write RPCs. Founder
-- decisions (2026-07-11): images only (JPEG/PNG/HEIC; PDF deferred to its own slice);
-- EXIF/geo stripped client-side AND server-re-validated (both layers — enforced by
-- the U2 upload Edge fn before record_upload); flat per-child inbox + status lifecycle
-- (no folder tree yet); 30-day fixed auto-delete interim window (U4 sweeps it; revisit
-- at the Phase-5 grading gate). The RECIPE-BOX RULE (ratified 2026-07-11) governs the
-- upload FLOW from U2 on. The client upload UI + EXIF strip = U2; storage-object purge
-- on child deletion + the 30-day sweep = U4.
--
-- HONEST RECORD: an uploaded page is the child's RAW WORK — its content columns are
-- write-once (set at record_upload, never updated); only status/graded_at change, via
-- set_upload_status. HARD RULE #1: no upload before Verifiable Parental Consent.
-- DEFINER HYGIENE: SECURITY DEFINER, search_path='', schema-qualified, authenticated.
-- ============================================================================

-- ---- uploads: one child-scoped inbox item (the raw photographed work) -----------
create table public.uploads (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children(id) on delete cascade,
  uploaded_by   uuid not null,                 -- auth.users.id (parent or granted tutor)
  uploader_role text not null check (uploader_role in ('parent', 'tutor')),
  storage_path  text not null unique,          -- object key in the private 'uploads' bucket: {child_id}/{uuid}.{ext}
  content_type  text not null check (content_type in ('image/jpeg', 'image/png', 'image/heic')),
  byte_size     int  not null check (byte_size > 0 and byte_size <= 10485760),   -- <= 10 MB
  exif_stripped boolean not null default false, -- the upload path MUST strip+re-validate (U2 Edge fn)
  note          text check (note is null or char_length(note) <= 200),           -- UNTRUSTED label, capped
  status        text not null default 'inbox' check (status in ('inbox', 'in_progress', 'graded', 'filed')),
  graded_at     timestamptz,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days'          -- interim auto-delete window (U4)
);
create index uploads_child_idx  on public.uploads (child_id, created_at desc);
create index uploads_expiry_idx on public.uploads (expires_at);

alter table public.uploads enable row level security;
alter table public.uploads force row level security;
revoke all on public.uploads from public, anon;
grant select on public.uploads to authenticated;   -- owner/granted READ; writes via RPC only
-- READ: the child's owner (parent/child) + an actively-granted tutor, consent-gated.
create policy uploads_select on public.uploads for select to authenticated
  using (public.can_view_child(child_id) and public.has_active_consent(child_id));
-- NO client insert/update/delete: record_upload / set_upload_status (definer) only.

-- ---- private Storage bucket (LOCKED: server-mediated signed URLs only) -----------
-- public=false + size/mime limits (defense-in-depth with the server re-validation).
-- NO permissive storage.objects policy is created for this bucket, so every client is
-- denied direct object access by default; the U2 Edge fn (service role) generates
-- short-lived signed upload/download URLs after an ownership check.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('uploads', 'uploads', false, 10485760, array['image/jpeg', 'image/png', 'image/heic'])
  on conflict (id) do update set
    public = false, file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/heic'];

-- ---- record_upload: the single write path (owner/granted + validated) -----------
-- Called by the U2 upload Edge fn on behalf of the user (JWT forwarded), AFTER it has
-- stripped EXIF, re-validated the file, and stored the object at a child-namespaced
-- path. Re-checks ownership + consent + type + size + path namespacing server-side.
-- The uploader_role is DERIVED from the caller's relationship (never client-supplied),
-- and uploads are an ADULT action in Phase 4 (never a child login). RATE-LIMIT NOTE:
-- U2's Edge fn MUST enforce per-child/account upload rate-limiting + bot protection
-- (HARD RULE #8) before this is exposed to a real client.
create or replace function public.record_upload(
  p_child_id uuid, p_storage_path text, p_content_type text, p_byte_size int,
  p_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_role text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  -- uploads are an ADULT action (parent / granted tutor); never a child login
  if public.is_child_actor(v_uid) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- the owner (parent) or a CAN-WRITE granted tutor may add work for this child
  if not public.can_write_child(p_child_id) then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not public.has_active_consent(p_child_id) then return jsonb_build_object('ok', false, 'error', 'no_consent'); end if; -- HARD RULE #1
  if p_content_type not in ('image/jpeg', 'image/png', 'image/heic') then return jsonb_build_object('ok', false, 'error', 'bad_type'); end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 10485760 then return jsonb_build_object('ok', false, 'error', 'bad_size'); end if;
  -- the object path MUST be namespaced under THIS child (blocks cross-child paths)
  if p_storage_path is null or p_storage_path not like (p_child_id::text || '/%') then
    return jsonb_build_object('ok', false, 'error', 'bad_path');
  end if;
  -- role DERIVED server-side (parent if they own the child, else a granted tutor) —
  -- never trusted from the client.
  v_role := case when exists (select 1 from public.children where id = p_child_id and parent_id = v_uid) then 'parent' else 'tutor' end;
  -- exif_stripped stays FALSE here: U1's RPC cannot verify a strip happened. U2's
  -- upload Edge fn strips + re-validates server-side and is the ONLY authority that may
  -- mark it true; nothing may TRUST this flag (e.g. for grading) until it does.
  insert into public.uploads (child_id, uploaded_by, uploader_role, storage_path, content_type, byte_size, note)
    values (p_child_id, v_uid, v_role, p_storage_path, p_content_type, p_byte_size, nullif(btrim(coalesce(p_note, '')), ''))
    returning id into v_id;
  insert into public.audit_log (actor_id, action, child_id, decision, detail)
    values (v_uid, 'upload.record', p_child_id, 'allow', jsonb_build_object('upload_id', v_id, 'role', v_role, 'content_type', p_content_type, 'bytes', p_byte_size));
  return jsonb_build_object('ok', true, 'upload_id', v_id);
end $$;
revoke all on function public.record_upload(uuid, text, text, int, text) from public, anon;
grant execute on function public.record_upload(uuid, text, text, int, text) to authenticated;

-- ---- set_upload_status: owner/granted moves an item through the lifecycle --------
-- Only status/graded_at change (the raw work stays immutable). Uniform not_found for
-- not-mine / not-there. graded_at stamps on the 'graded' transition.
create or replace function public.set_upload_status(p_upload_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_u public.uploads%rowtype;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'unauthenticated'); end if;
  if p_status not in ('inbox', 'in_progress', 'graded', 'filed') then return jsonb_build_object('ok', false, 'error', 'bad_status'); end if;
  select * into v_u from public.uploads where id = p_upload_id;
  if v_u.id is null or not public.can_write_child(v_u.child_id) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update public.uploads
     set status = p_status,
         graded_at = case when p_status = 'graded' then now() else graded_at end
   where id = p_upload_id;
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;
revoke all on function public.set_upload_status(uuid, text) from public, anon;
grant execute on function public.set_upload_status(uuid, text) to authenticated;