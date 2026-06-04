-- ═══════════════════════════════════════════════════════════════════════════
-- 0258 — pms_table_schemas DESCRIPTOR fixups (two targeted corrections).
--
-- Why this exists:
--   Same descriptor-vs-table relationship as 0255: the 0202 table CHECK
--   constraints are AUTHORITATIVE; the `pms_table_schemas` descriptors only
--   tell the CUA generic-table-writer which columns to refresh and which
--   enum values to pre-screen. This migration does NOT touch any table CHECK
--   constraint — it only rewrites descriptor `columns`.
--
--   Two corrections:
--
--   1. pms_housekeeping_assignments — DROP the `status` column from the
--      descriptor.
--        Current descriptor columns:
--          date, room_number, housekeeper_name, cleaning_type, status,
--          dnd_active
--        The lifecycle `status` (e.g. a manager's mark-clean) is owned by the
--        operator/UI, NOT by the PMS feed. While `status` stays in the
--        descriptor the CUA refresh pass overwrites it on every poll, so the
--        robot can revert a manager's mark-clean back to whatever the PMS
--        screen shows — a real first-run risk. Removing it means the CUA only
--        refreshes housekeeper_name / cleaning_type / dnd_active (plus the
--        date/room_number keys) and never clobbers the manager-set status.
--
--   2. pms_lost_and_found.status — align descriptor allowed_values to the
--      0202 table CHECK exactly.
--        0207 descriptor: unclaimed, claimed, disposed
--        0202 CHECK:      open, claimed, disposed, shipped, expired
--        → descriptor had 'unclaimed' (NOT in CHECK) and was missing 'open',
--          'shipped', 'expired'. Valid statuses were being rejected by the
--          descriptor gate even though the table would accept them.
--
-- How:
--   Per table, walk the existing descriptor `columns` jsonb array and rewrite
--   it in place — fix #1 filters OUT the `status` element, fix #2 rewrites
--   ONLY the `allowed_values` key of the matching column object, leaving every
--   other field untouched. Both are fully idempotent (re-running yields the
--   identical array) and guarded by EXISTS so they no-op cleanly once applied
--   or if a table/column row is absent.
--
-- Idempotent: each UPDATE is a deterministic rewrite — safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. pms_housekeeping_assignments — drop the `status` descriptor column ────
update public.pms_table_schemas
set columns = (
      select jsonb_agg(elem order by ord)
      from jsonb_array_elements(columns) with ordinality as t(elem, ord)
      where elem->>'name' <> 'status'
    ),
    updated_at = now()
where table_name = 'pms_housekeeping_assignments'
  and exists (
    select 1 from jsonb_array_elements(columns) e
    where e->>'name' = 'status'
  );

-- ─── 2. pms_lost_and_found.status ────────────────────────────────────────────
update public.pms_table_schemas
set columns = (
      select jsonb_agg(
        case
          when elem->>'name' = 'status'
            then elem || jsonb_build_object('allowed_values', jsonb_build_array(
              'open',
              'claimed',
              'disposed',
              'shipped',
              'expired'
            ))
          else elem
        end
        order by ord
      )
      from jsonb_array_elements(columns) with ordinality as t(elem, ord)
    ),
    updated_at = now()
where table_name = 'pms_lost_and_found'
  and exists (
    select 1 from jsonb_array_elements(columns) e
    where e->>'name' = 'status'
  );

-- ─── Track the migration ─────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0258', 'pms_table_schemas descriptor fixups: drop status from pms_housekeeping_assignments descriptor so the CUA refresh never clobbers the manager-set lifecycle status; align pms_lost_and_found.status descriptor allowed_values to the 0202 table CHECK (open, claimed, disposed, shipped, expired). Descriptors only — CHECK constraints unchanged (CHECK is authoritative).')
on conflict (version) do nothing;

-- ─── PostgREST schema reload ─────────────────────────────────────────────────
notify pgrst, 'reload schema';
