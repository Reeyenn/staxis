-- 0288_coverage_delete.sql
-- feature/coverage-hotel-list-delete — SOFT-delete for a learned PMS coverage.
--
-- "Delete a PMS coverage" from the admin studio stamps deleted_at on every
-- pms_knowledge_files row of the family (all versions) and detaches every hotel
-- on it (pms_type=NULL + session 'stopped'). With no hotel assigned, the worker
-- has nothing to poll for that family and stops cleanly — NO cua-service change.
--
-- It is a SOFT delete on purpose: the expensive Claude-vision-learned recipe is
-- KEPT (deleted_at stamped, never dropped), so a mistaken delete is restorable
-- (clear deleted_at + re-attach hotels). The admin studio + /api/admin/pms-coverage
-- hide rows where deleted_at IS NOT NULL.
--
-- ⚠️ deleted_at is OUTSIDE the HMAC-signed `knowledge` envelope (like display_name,
-- 0287) — stamping it never invalidates a recipe signature. Never fold into knowledge.
--
-- Additive + idempotent. No RLS change (table stays service-role-only, 0201).

alter table public.pms_knowledge_files
  add column if not exists deleted_at timestamptz;

comment on column public.pms_knowledge_files.deleted_at is
  'When set, this learned PMS coverage is soft-deleted: hidden from the admin studio + /api/admin/pms-coverage, its hotels detached. The recipe is preserved for restore. Outside the HMAC-signed knowledge envelope. Added 0288.';

insert into public.applied_migrations (version, description)
values ('0288', 'feature/coverage-hotel-list-delete: pms_knowledge_files.deleted_at — soft-delete a learned PMS coverage (hidden from studio, hotels detached, recipe preserved for restore; outside the signed envelope).')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
