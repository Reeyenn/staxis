-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0131: Maintenance simplification (Claude Design handoff)
--
-- The Maintenance tab is being collapsed from 5 sub-tabs (work orders /
-- preventive / equipment / landscaping / vendors+contracts) down to 2:
-- Work Orders + Preventive. New UX is the "physical book replacement"
-- pattern: open → done, no in-progress.
--
-- This migration is additive only. No DROPs, no CHECK changes. Equipment,
-- vendors, service_contracts, landscaping_tasks, inspections tables stay
-- in place (data preservation). The UI just stops reading/writing them.
--
-- TS layer maps:
--   status:   'open' ↔ DB 'submitted'   |   'done' ↔ DB 'resolved'
--   priority: 'normal' ↔ DB severity 'medium'   (urgent/low identity)
--
-- The new columns capture:
--   - submitter_role: free-text role label (e.g. "Front desk") to show
--     "Sam P. · Front desk" without joining staff
--   - submitter_photo_path / completion_photo_path: Supabase Storage
--     paths in the new maintenance-photos bucket
--   - completion_note: optional free-text note when marking done
--   - completed_by_name: who clicked Mark Done (separate from
--     assigned_name which was the dispatch concept we're retiring)
--   - preventive_tasks.area: free-text location/area ("Floor 2",
--     "Building", "Pool")
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Storage bucket for maintenance photos ─────────────────────────────────
insert into storage.buckets (id, name, public)
values ('maintenance-photos', 'maintenance-photos', false)
on conflict (id) do nothing;

-- RLS policies on the bucket: any authenticated user can read/write/delete
-- objects in this bucket. Property scoping is enforced at the path level
-- by the application code (`${propertyId}/${filename}`) — which matches the
-- existing pattern for the 'counts' and 'invoices' buckets used by
-- inventory. Tighter per-property RLS can be added later without an API
-- break.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'maintenance_photos_read'
  ) then
    create policy "maintenance_photos_read"
      on storage.objects for select to authenticated
      using (bucket_id = 'maintenance-photos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'maintenance_photos_write'
  ) then
    create policy "maintenance_photos_write"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'maintenance-photos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'maintenance_photos_delete'
  ) then
    create policy "maintenance_photos_delete"
      on storage.objects for delete to authenticated
      using (bucket_id = 'maintenance-photos');
  end if;
end$$;

-- 2. work_orders: new columns for the simplified flow ──────────────────────
alter table work_orders
  add column if not exists submitter_role        text,
  add column if not exists submitter_photo_path  text,
  add column if not exists completion_photo_path text,
  add column if not exists completion_note       text,
  add column if not exists completed_by_name     text;

comment on column work_orders.submitter_role is
  'Free-text role of the person who submitted (e.g. "Front desk", "Head housekeeper", "General manager"). Shown in the open-card byline so we do not need to join staff.';
comment on column work_orders.submitter_photo_path is
  'Storage path in the maintenance-photos bucket for the photo attached at submission time.';
comment on column work_orders.completion_photo_path is
  'Storage path in the maintenance-photos bucket for the photo attached at mark-done time.';
comment on column work_orders.completion_note is
  'Optional free-text note written when marking the work order done — "replaced filter, unit is old".';
comment on column work_orders.completed_by_name is
  'Display name of the staff member who clicked Mark Done (distinct from assigned_name which was the legacy dispatch concept).';

-- 3. preventive_tasks: area column ─────────────────────────────────────────
alter table preventive_tasks
  add column if not exists area                  text,
  add column if not exists completion_photo_path text;

comment on column preventive_tasks.area is
  'Free-text location/area the recurring task applies to ("Floor 2", "Building", "Pool"). Shown next to the task name.';
comment on column preventive_tasks.completion_photo_path is
  'Storage path in the maintenance-photos bucket for the photo attached at task-completion time.';

-- 4. Track migration ───────────────────────────────────────────────────────
insert into applied_migrations (version, description)
values (
  '0131',
  'maintenance simplification: maintenance-photos bucket, work_orders submitter/completion fields, preventive_tasks area'
)
on conflict (version) do nothing;
