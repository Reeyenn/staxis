-- 0265 — Backfill the work_orders columns that drifted out of prod.
--
-- (Renumbered from 0264 → 0265: version 0264 was taken in prod by a parallel
-- session's "AI Agent Builder FOUNDATION" migration.)
--
-- Found 2026-06-04 while fixing the Maintenance Work Orders submit: the LIVE
-- work_orders table was MISSING the five columns migration 0131
-- ("maintenance_simplify") adds —
--   submitter_role, submitter_photo_path, completion_photo_path,
--   completion_note, completed_by_name
-- — even though 0131's preventive_tasks half (area, completion_photo_path) IS
-- present (which is why Preventive worked and Work Orders didn't). The table
-- still carried the pre-0131 columns (submitted_by, assigned_name, photo_url),
-- so work_orders had been rebuilt/patched out-of-band at some point without the
-- 0131 additions.
--
-- The shared mapper (toWorkOrderRow) writes all five on every submit /
-- mark-done, so once 0263 restored browser access the insert reached PostgREST
-- and 400'd with PGRST204 "Could not find the 'submitter_role' column … in the
-- schema cache". Re-add them with 0131's exact definitions. All nullable text —
-- additive, no effect on existing rows or live main. (Verified live: submit →
-- board → mark done → history all work after applying.)

alter table public.work_orders
  add column if not exists submitter_role        text,
  add column if not exists submitter_photo_path  text,
  add column if not exists completion_photo_path text,
  add column if not exists completion_note       text,
  add column if not exists completed_by_name     text;

comment on column public.work_orders.submitter_role is
  'Free-text role label of the submitter (e.g. "Front desk", "General manager"). Shown in the byline. (0131; backfilled 0265.)';
comment on column public.work_orders.submitter_photo_path is
  'Supabase Storage path (maintenance-photos bucket) for the photo attached at submission. (0131; backfilled 0265.)';
comment on column public.work_orders.completion_photo_path is
  'Supabase Storage path (maintenance-photos bucket) for the photo attached at mark-done. (0131; backfilled 0265.)';
comment on column public.work_orders.completion_note is
  'Optional free-text note recorded when the order is marked done. (0131; backfilled 0265.)';
comment on column public.work_orders.completed_by_name is
  'Display name of who marked the order done (separate from the submitter). (0131; backfilled 0265.)';

insert into public.applied_migrations (version, description)
values (
  '0265',
  'Backfill work_orders 0131 columns missing from prod (submitter_role, submitter_photo_path, completion_photo_path, completion_note, completed_by_name) — caused PGRST204 on Maintenance work-order submit/mark-done once 0263 restored browser access. (Renumbered from 0264; that version is the parallel AI Agent Builder migration.)'
)
on conflict (version) do nothing;

-- Reload PostgREST so the REST layer sees the new columns immediately.
notify pgrst, 'reload schema';
