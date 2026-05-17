-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0141: Drop dead schema (audit/data-model cleanup)
-- (Originally drafted as 0132; renumbered after rebase to avoid collision
-- with main's 0132_active_property_ids_for_nudges.sql / 0133_realtime_replica_identity_full.sql.
-- Schema changes already applied to prod 2026-05-17 — this migration's INSERT
-- into applied_migrations is the bookkeeping catch-up.)
--
-- The May 2026 data-model audit (.claude/reports/data-model-map.md) found
-- eight tables with no live reader+writer pair across app code, scripts,
-- ml-service, cua-service, scraper, or RPC functions. Migration 0131
-- preserved them under a "data preservation" stance — this migration
-- reverses that decision now that the audit has confirmed zero call sites
-- in any source tree. If any of these features are ever revived, the
-- schema can be re-created clean.
--
-- Dropped tables:
--   1. equipment              (0029) — service toggle in onboarding but no
--                                       reads/writes; vacuum/tool registry
--                                       feature never shipped.
--   2. vendors                (0043) — paired with service_contracts; never
--                                       wired to UI or API.
--   3. service_contracts      (0043) — same.
--   4. inspections            (0001) — placeholder from initial schema; the
--                                       maintenance tab uses preventive_tasks
--                                       for recurring work.
--   5. landscaping_tasks      (0001) — placeholder from initial schema;
--                                       work_orders absorbs this.
--   6. voice_recordings       (0117) — retired 2026-05-14 (INVARIANTS.md
--                                       INV-18/19) when voice moved from
--                                       Whisper-per-clip to ElevenLabs
--                                       streaming. No writer remains.
--   7. inventory_rate_prediction_history (0075) — populated by a trigger on
--                                       inventory_rate_predictions but never
--                                       read. "Future backtest" archive that
--                                       was never built.
--   8. prediction_disagreement (0021) — never written by any code path; the
--                                       only reader (getRecentDisagreements
--                                       in ml-stubs.ts) had no callers.
--
-- Live tables losing dead columns:
--   - work_orders: equipment_id, vendor_id, repair_cost, parts_used
--                  (all added in 0030/0043; zero app references).
--   - preventive_tasks: equipment_id (0030; zero references).
--
-- Dropped trigger + function:
--   - inventory_rate_predictions_archive (trigger on inventory_rate_predictions)
--   - public.archive_inventory_rate_prediction() (function)
-- Both go away with the archive table.
--
-- Realtime publication: Postgres auto-removes a dropped table from any
-- publication, so no separate ALTER PUBLICATION step is needed.
--
-- Storage bucket cleanup (voice-recordings) is manual via Supabase UI —
-- buckets aren't managed via this migration tree.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Drop the archive trigger + function (must happen before the archive
--    table is dropped, otherwise the trigger fires on the next
--    inventory_rate_predictions write against a non-existent target).
drop trigger if exists inventory_rate_predictions_archive on public.inventory_rate_predictions;
drop function if exists public.archive_inventory_rate_prediction();

-- 2. Drop dead FK columns on live tables. These point at tables we are
--    about to drop. Doing this before the table drops avoids relying on
--    CASCADE to silently rewrite live tables' schemas (explicit > implicit).
alter table public.work_orders
  drop column if exists equipment_id,
  drop column if exists vendor_id,
  drop column if exists repair_cost,
  drop column if exists parts_used;

alter table public.preventive_tasks
  drop column if exists equipment_id;

-- 3. Drop the 8 dead tables. CASCADE handles their touch triggers, RLS
--    policies, indexes, and any remaining FK-out constraints
--    (equipment → vendors, service_contracts → vendors).
drop table if exists public.equipment              cascade;
drop table if exists public.service_contracts      cascade;
drop table if exists public.vendors                cascade;
drop table if exists public.inspections            cascade;
drop table if exists public.landscaping_tasks      cascade;
drop table if exists public.voice_recordings       cascade;
drop table if exists public.inventory_rate_prediction_history cascade;
drop table if exists public.prediction_disagreement cascade;

-- 4. Track migration.
insert into applied_migrations (version, description)
values (
  '0141',
  'drop dead schema: 8 tables (equipment, vendors, service_contracts, inspections, landscaping_tasks, voice_recordings, inventory_rate_prediction_history, prediction_disagreement) + dead FK columns on work_orders/preventive_tasks + archive trigger'
)
on conflict (version) do nothing;
