-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0028: Storage buckets for invoice OCR + photo counting
--
-- The Vision-API features (Invoice OCR, Photo Counting) upload images to
-- Supabase Storage so the originals are kept on file for audit, dispute,
-- and re-processing. Two buckets:
--
--   invoices/  — vendor invoices scanned via the inventory hero
--   counts/    — shelf photos taken from inside Count Mode
--
-- Both are PRIVATE buckets — listed in the dashboard, not on the public CDN.
-- The API routes that call Vision use the service-role key to read them, and
-- the inventory page UI uses signed URLs for the brief preview window.
--
-- Path convention: {property_id}/{ISO-timestamp}.{ext}
-- → makes per-property cleanup trivial and keeps the per-property RLS
--   easy to write (path starts with the property uuid).
--
-- Idempotent — every upsert/insert uses ON CONFLICT.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Create buckets (private, image/* + application/pdf only) ────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('invoices', 'invoices', false, 10485760,
    array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']),
  ('counts',   'counts',   false, 10485760,
    array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. RLS policies on storage.objects ──────────────────────────────────────
-- The path encodes the property id as the first folder segment, so the
-- policy can extract it via storage.foldername() and check ownership via
-- the same user_owns_property() helper used everywhere else.

drop policy if exists "owner rw invoices"  on storage.objects;
create policy "owner rw invoices"
  on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'invoices'
    and user_owns_property((storage.foldername(name))[1]::uuid)
  )
  with check (
    bucket_id = 'invoices'
    and user_owns_property((storage.foldername(name))[1]::uuid)
  );

drop policy if exists "owner rw counts"  on storage.objects;
create policy "owner rw counts"
  on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'counts'
    and user_owns_property((storage.foldername(name))[1]::uuid)
  )
  with check (
    bucket_id = 'counts'
    and user_owns_property((storage.foldername(name))[1]::uuid)
  );

-- 3. Track migration ──────────────────────────────────────────────────────
insert into applied_migrations (version, description)
values ('0028', 'inventory_storage_buckets: invoices + counts buckets with owner RLS')
on conflict (version) do nothing;
