-- ═══════════════════════════════════════════════════════════════════════════
-- 0255 — Align pms_table_schemas DESCRIPTOR allowed_values to the 0202 table
--        CHECK constraints (descriptor-vs-CHECK enum drift fix).
--
-- Why this exists:
--   0202 created the pms_* tables with column CHECK constraints that define
--   the canonical enum vocabulary the database actually accepts. 0207 later
--   seeded the `pms_table_schemas` descriptors with an `allowed_values` list
--   per enum column — the list the generic-table-writer + validators use to
--   pre-screen incoming CUA values BEFORE the insert. Those two drifted:
--   several descriptor allowed_values sets are NARROWER than (or simply
--   disagree with) the 0202 CHECK sets. The effect is that real, perfectly
--   valid PMS values get rejected by the descriptor gate even though the
--   table would have accepted them.
--
--   The 0202 CHECK is AUTHORITATIVE. This migration does NOT touch any table
--   CHECK constraint — it only rewrites the descriptor `allowed_values` so
--   they EXACTLY match the corresponding 0202 CHECK sets.
--
--   Specific drift corrected (0207 descriptor → 0202 CHECK):
--
--   1. pms_room_status_log.status
--        0207: occupied, vacant_clean, vacant_dirty, inspected, out_of_order,
--              unknown
--        0202 CHECK adds: occupied_clean, occupied_dirty, out_of_inventory
--        → descriptor was missing 3 valid statuses.
--
--   2. pms_housekeeping_assignments.cleaning_type
--        0207: departure, stayover, refresh, deep_clean, unknown
--        0202 CHECK: departure, stayover, deep, refresh, inspection, arrival
--        → 0207 had 'deep_clean' (CHECK uses 'deep'), had 'unknown'
--          (NOT in CHECK), and was missing 'inspection' + 'arrival'.
--
--   3. pms_work_orders_v2.priority
--        0207: low, medium, high, critical, unknown
--        0202 CHECK: urgent, high, medium, low
--        → 0207 had 'critical' + 'unknown' (NOT in CHECK) and was missing
--          'urgent'.
--
--   4. pms_work_orders_v2.status
--        0207: open, in_progress, resolved, cancelled
--        0202 CHECK: open, in_progress, closed, deferred, resolved
--        → 0207 had 'cancelled' (NOT in CHECK) and was missing 'closed' +
--          'deferred'.
--
-- How:
--   Per table, walk the existing descriptor `columns` jsonb array and rewrite
--   ONLY the `allowed_values` key of the one matching column object, leaving
--   every other field (name/type/required/nullable/range_*) untouched. This
--   is fully idempotent (re-running yields the identical array) and never
--   clobbers unrelated descriptor edits. No-ops cleanly if a table/column
--   row is absent.
--
-- Idempotent: each UPDATE is a deterministic rewrite — safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. pms_room_status_log.status ───────────────────────────────────────────
update public.pms_table_schemas
set columns = (
      select jsonb_agg(
        case
          when elem->>'name' = 'status'
            then elem || jsonb_build_object('allowed_values', jsonb_build_array(
              'vacant_clean',
              'vacant_dirty',
              'occupied',
              'occupied_clean',
              'occupied_dirty',
              'out_of_order',
              'out_of_inventory',
              'inspected',
              'unknown'
            ))
          else elem
        end
        order by ord
      )
      from jsonb_array_elements(columns) with ordinality as t(elem, ord)
    ),
    updated_at = now()
where table_name = 'pms_room_status_log'
  and exists (
    select 1 from jsonb_array_elements(columns) e
    where e->>'name' = 'status'
  );

-- ─── 2. pms_housekeeping_assignments.cleaning_type ───────────────────────────
update public.pms_table_schemas
set columns = (
      select jsonb_agg(
        case
          when elem->>'name' = 'cleaning_type'
            then elem || jsonb_build_object('allowed_values', jsonb_build_array(
              'departure',
              'stayover',
              'deep',
              'refresh',
              'inspection',
              'arrival'
            ))
          else elem
        end
        order by ord
      )
      from jsonb_array_elements(columns) with ordinality as t(elem, ord)
    ),
    updated_at = now()
where table_name = 'pms_housekeeping_assignments'
  and exists (
    select 1 from jsonb_array_elements(columns) e
    where e->>'name' = 'cleaning_type'
  );

-- ─── 3. pms_work_orders_v2.priority + .status ────────────────────────────────
update public.pms_table_schemas
set columns = (
      select jsonb_agg(
        case
          when elem->>'name' = 'priority'
            then elem || jsonb_build_object('allowed_values', jsonb_build_array(
              'urgent',
              'high',
              'medium',
              'low'
            ))
          when elem->>'name' = 'status'
            then elem || jsonb_build_object('allowed_values', jsonb_build_array(
              'open',
              'in_progress',
              'closed',
              'deferred',
              'resolved'
            ))
          else elem
        end
        order by ord
      )
      from jsonb_array_elements(columns) with ordinality as t(elem, ord)
    ),
    updated_at = now()
where table_name = 'pms_work_orders_v2'
  and exists (
    select 1 from jsonb_array_elements(columns) e
    where e->>'name' in ('priority', 'status')
  );

-- ─── Track the migration ─────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0255', 'Align pms_table_schemas descriptor allowed_values to the 0202 table CHECK constraints (descriptor-vs-CHECK enum drift): pms_room_status_log.status, pms_housekeeping_assignments.cleaning_type, pms_work_orders_v2.status + .priority. Descriptors only — CHECK constraints unchanged (CHECK is authoritative).')
on conflict (version) do nothing;

-- ─── PostgREST schema reload ─────────────────────────────────────────────────
notify pgrst, 'reload schema';
