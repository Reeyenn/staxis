-- Migration 0144: tighten maintenance-photos storage bucket to per-property RLS
--
-- Security review 2026-05-16 (Surface 2 P2 — Pattern D): the
-- maintenance-photos bucket policies introduced in 0131 are auth-only
-- (`using (bucket_id = 'maintenance-photos')`), not per-property. Any
-- authenticated user across all tenants could read another tenant's
-- maintenance photos via direct storage URLs if they could guess
-- `{propertyId}/{filename}` paths. Path randomness from the Supabase
-- helper made guessing impractical at day-1, but defense-in-depth
-- demands the same per-property RLS pattern that the invoices/counts
-- buckets already use.
--
-- This migration replaces all three policies with `user_owns_property`
-- checks on the first path segment, matching invoices/counts. App-layer
-- code already writes paths as `${propertyId}/${filename}` so no API
-- break.

do $$
begin
  -- Drop the auth-only policies if they exist.
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'maintenance_photos_read'
  ) then
    drop policy "maintenance_photos_read" on storage.objects;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'maintenance_photos_write'
  ) then
    drop policy "maintenance_photos_write" on storage.objects;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'maintenance_photos_delete'
  ) then
    drop policy "maintenance_photos_delete" on storage.objects;
  end if;

  -- Re-create with per-property RLS. The first path segment is the
  -- property UUID (`{propertyId}/{filename}`); `storage.foldername(name)`
  -- returns a text[] of segments. Same shape invoices/counts use.
  create policy "maintenance_photos_read_owner"
    on storage.objects for select to authenticated
    using (
      bucket_id = 'maintenance-photos'
      and (storage.foldername(name))[1] is not null
      and user_owns_property(((storage.foldername(name))[1])::uuid)
    );

  create policy "maintenance_photos_write_owner"
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'maintenance-photos'
      and (storage.foldername(name))[1] is not null
      and user_owns_property(((storage.foldername(name))[1])::uuid)
    );

  create policy "maintenance_photos_delete_owner"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'maintenance-photos'
      and (storage.foldername(name))[1] is not null
      and user_owns_property(((storage.foldername(name))[1])::uuid)
    );
end$$;

insert into public.applied_migrations (version, description)
values ('0144', 'maintenance-photos bucket: per-property RLS via user_owns_property() on path[1] — closes Surface 2 P2')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
