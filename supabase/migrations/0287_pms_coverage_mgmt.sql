-- 0287_pms_coverage_mgmt.sql
-- feature/cua-coverage-mgmt — let the founder MATCH / SWITCH / DETACH / BULK-assign
-- a hotel's PMS coverage and RENAME a learned coverage from the admin studio.
--
-- The only schema change this whole feature needs is a single nullable column:
-- a human-friendly DISPLAY NAME for a learned PMS coverage. Everything else
-- (which hotel is on which coverage, start/stop a driver) already lives in
-- property_sessions + properties.pms_type and is driven entirely by the new
-- /api/admin/coverage/* routes — no DDL required for those.
--
-- display_name semantics:
--   - One row per pms_family is `status='active'` (the live recipe the worker
--     replays). The rename route writes display_name on THAT row ONLY.
--   - It is read as COALESCE(display_name, <PMS registry label>) everywhere the
--     coverage is shown, so an un-renamed coverage still gets its registry label.
--   - ⚠️ The worker HMAC-verifies the `knowledge` jsonb against `signature`.
--     display_name is OUTSIDE that envelope (a plain metadata column), so
--     setting it NEVER invalidates the signature. Renaming is therefore safe to
--     do on a live coverage. NEVER fold display_name into `knowledge`.
--
-- Additive + idempotent (`add column if not exists`). No RLS change: the table
-- stays service-role-only (0201); the admin API writes via supabaseAdmin.

alter table public.pms_knowledge_files
  add column if not exists display_name text;

comment on column public.pms_knowledge_files.display_name is
  'Optional founder-set friendly name for this learned PMS coverage. Read as COALESCE(display_name, PMS registry label). Set on the active row only, via /api/admin/coverage/rename. OUTSIDE the HMAC-signed knowledge envelope — safe to change on a live recipe. Added 0287.';

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0287', 'feature/cua-coverage-mgmt: pms_knowledge_files.display_name — founder-set friendly name for a learned PMS coverage (COALESCE with registry label; outside the signed knowledge envelope).')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
