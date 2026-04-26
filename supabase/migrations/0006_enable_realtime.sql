-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Enable Supabase Realtime postgres_changes
--
-- Problem this solves:
--   Every page in the app subscribes to live data via Supabase Realtime
--   (subscribeToStaff, subscribeToRooms, subscribeToWorkOrders, etc.).
--   For these subscriptions to fire, the relevant tables MUST be added to
--   the `supabase_realtime` publication. The Firebase migration on
--   2026-04-22 left a TODO comment in 0001_initial_schema.sql that said
--   "Run separately... in supabase/migrations/0002_realtime.sql" but that
--   file was never written, so postgres_changes never fired for any
--   self-originated mutation.
--
--   Symptom: every UI form that depends on the realtime channel to
--   refresh local React state after a save showed stale data on reopen
--   until the user manually reloaded the tab. Reeyen reported this
--   specifically for the Staff edit modal on 2026-04-26 — same pattern
--   exists on every page that calls subscribeTo* in db.ts.
--
-- Fix:
--   1. Make sure the `supabase_realtime` publication exists.
--   2. ALTER PUBLICATION ... ADD TABLE for every table the app subscribes
--      to. Idempotent guards in case some are already added on a fresh
--      project.
--   3. Set REPLICA IDENTITY FULL on each table so DELETE / UPDATE events
--      include the FULL old row. Without this, postgres_changes can fire
--      for INSERTs but lose info on UPDATE/DELETE under some RLS
--      configurations.
--
-- This migration is safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Make sure the publication exists ─────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- 2. Add tables to the publication (idempotent) ──────────────────────────────
do $$
declare
  t text;
  tables_to_publish text[] := array[
    'staff',
    'rooms',
    'work_orders',
    'preventive_tasks',
    'landscaping_tasks',
    'inventory',
    'inspections',
    'handoff_logs',
    'guest_requests',
    'plan_snapshots',
    'schedule_assignments',
    'shift_confirmations',
    'manager_notifications',
    'scraper_status'
  ];
begin
  foreach t in array tables_to_publish
  loop
    -- Only add if the table isn't already in the publication. ALTER
    -- PUBLICATION ... ADD TABLE errors if the table is already a member,
    -- so we check first to keep the migration idempotent.
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 3. REPLICA IDENTITY FULL so UPDATE/DELETE events carry the full old row ───
--    Postgres' default REPLICA IDENTITY is the primary key only, which means
--    realtime listeners receive only the PK on UPDATE/DELETE. With FULL,
--    payloads include every column — required so the client can compare
--    old vs new and update local state correctly.
do $$
declare
  t text;
  tables_to_publish text[] := array[
    'staff',
    'rooms',
    'work_orders',
    'preventive_tasks',
    'landscaping_tasks',
    'inventory',
    'inspections',
    'handoff_logs',
    'guest_requests',
    'plan_snapshots',
    'schedule_assignments',
    'shift_confirmations',
    'manager_notifications',
    'scraper_status'
  ];
begin
  foreach t in array tables_to_publish
  loop
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;
