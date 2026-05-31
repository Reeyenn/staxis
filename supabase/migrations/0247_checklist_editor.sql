-- ═══════════════════════════════════════════════════════════════════════════
-- 0247 — Checklist editor: per-property inspection-checklist uniqueness
--
-- Supports the manager-facing checklist editor (Settings → Checklists). The
-- editor builds on the EXISTING checklist tables (0212 inspection, 0222
-- cleaning) — it adds NO tables and changes NO RLS. The cleaning side already
-- has the partial unique index it needs (cct_property_one_per_type_idx on
-- (property_id, cleaning_type) where property_id is not null, from 0222).
--
-- The inspection side had no equivalent. The editor treats a property's
-- inspection checklist as identified by (property_id, name): that's how it
-- finds the row to update on save and how "copy to other properties"
-- overwrites idempotently. Without a uniqueness guard, a race or a repeated
-- copy could create two per-property rows with the same name, which then makes
-- the find-by-name lookup ambiguous.
--
-- This migration adds a PARTIAL unique index on (property_id, name) that
-- applies ONLY to per-property rows (property_id IS NOT NULL). Global Staxis
-- defaults (property_id IS NULL) are intentionally excluded — several global
-- defaults may share scopes, and the editor never writes them.
--
-- The application code is written to work WITH OR WITHOUT this index (the
-- find-by-name lookup is deterministic and a unique-violation on insert is
-- caught and retried as an update), so deploying the feature before this
-- migration is applied is safe — the index is pure hardening that makes the
-- one-checklist-per-(property,name) invariant true at the DB level.
--
-- Safe to apply to current prod: the only existing inspection checklist is the
-- global default (property_id IS NULL, excluded by the WHERE clause), and no
-- per-property inspection checklists exist yet.
--
-- Manual prod apply per project_migration_application_manual.md. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

create unique index if not exists inspection_checklists_property_name_uniq
  on public.inspection_checklists (property_id, name)
  where property_id is not null;

insert into public.applied_migrations (version, description)
values (
  '0247',
  'Checklist editor: partial unique index on inspection_checklists (property_id, name) where property_id is not null — makes per-property inspection checklists idempotent for the manager editor + copy-to-properties.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
