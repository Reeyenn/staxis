-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Restrict realtime payload columns for sensitive
-- tables.
--
-- Problem this solves:
--   The 0006_enable_realtime.sql migration added every multi-tenant table
--   to the `supabase_realtime` publication AND set `replica identity full`
--   on each. That was correct for getting realtime working, but it has a
--   side effect: every realtime UPDATE/INSERT/DELETE event delivered to
--   subscribers contains every column on the row.
--
--   RLS still applies (a subscriber only gets payloads for rows they can
--   see), but the staff table's RLS lets staff-role users see all the
--   staff at THEIR property — including each other's `phone`,
--   `phone_lookup`, and `hourly_wage`. A non-manager who triggers any
--   colleague's row update (or the colleague triggers their own) would
--   receive that colleague's wage and personal phone in the realtime
--   delta. The Staxis app never displays those fields to a staff-role
--   user, but realtime payloads are visible in the browser DevTools to
--   anyone running the app.
--
--   Same issue on `shift_confirmations`: the table broadcasts
--   `staff_phone` to anyone with the property scoped read.
--
-- Fix:
--   Postgres publications support per-table column lists. We re-add
--   `staff` and `shift_confirmations` to the publication with explicit
--   column lists that EXCLUDE the sensitive columns. The columns are
--   still queryable through normal RLS-scoped supabaseAdmin reads (the
--   API routes that need them) but no longer leak through the realtime
--   firehose.
--
--   Note: column-filtered tables can still have `replica identity full`
--   — the publication's column list is what the broadcast carries, not
--   the WAL replica record. So existing UPDATE/DELETE detection still
--   works.
--
-- Safe to re-run: idempotent guards check each ALTER PUBLICATION step.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. STAFF — drop and re-add with column allow-list ─────────────────────
do $$
declare
  staff_columns text;
begin
  -- Allowed columns: everything visible in the Staff list/grid UI.
  -- Explicitly NOT broadcast: phone, phone_lookup, hourly_wage.
  --
  -- If a column is added to the staff table later that needs to be live,
  -- it must be added here too — otherwise realtime updates for it are
  -- silently dropped. The doctor endpoint should call this out.
  staff_columns := 'id, property_id, name, language, is_senior, ' ||
                   'department, scheduled_today, weekly_hours, ' ||
                   'max_weekly_hours, max_days_per_week, ' ||
                   'days_worked_this_week, vacation_dates, is_active, ' ||
                   'schedule_priority, is_scheduling_manager, ' ||
                   'created_at, updated_at';

  -- Remove the existing entry (if any). DROP TABLE on a non-member is an
  -- error, hence the guard.
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'staff'
  ) then
    execute 'alter publication supabase_realtime drop table public.staff';
  end if;

  -- Re-add with the column list.
  execute format(
    'alter publication supabase_realtime add table public.staff (%s)',
    staff_columns
  );
end $$;

-- ── 2. SHIFT_CONFIRMATIONS — drop and re-add without staff_phone ──────────
do $$
declare
  conf_columns text;
begin
  -- Allowed columns: everything the manager UI binds to. Explicitly NOT
  -- broadcast: staff_phone (raw E.164), sms_error (may include phone in
  -- Twilio error text).
  conf_columns := 'token, property_id, staff_id, staff_name, ' ||
                  'shift_date, status, language, sent_at, ' ||
                  'responded_at, sms_sent, created_at';

  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shift_confirmations'
  ) then
    execute 'alter publication supabase_realtime drop table public.shift_confirmations';
  end if;

  execute format(
    'alter publication supabase_realtime add table public.shift_confirmations (%s)',
    conf_columns
  );
end $$;

-- ── 3. Verification helper ────────────────────────────────────────────────
-- Returns the columns currently broadcast for each table in the
-- publication, so the doctor endpoint can confirm phone/wage are filtered
-- out without us having to read pg_attribute by hand.
create or replace function staxis_realtime_columns()
returns table(table_name text, allowed_columns text[])
language sql
security definer
set search_path = public, pg_catalog
as $$
  select
    pt.tablename::text as table_name,
    coalesce(pt.attnames, array(
      select attname::text
      from pg_attribute
      where attrelid = (pt.schemaname || '.' || pt.tablename)::regclass
        and attnum > 0 and not attisdropped
    )) as allowed_columns
  from pg_publication_tables pt
  where pt.pubname = 'supabase_realtime'
    and pt.schemaname = 'public'
$$;

revoke all on function staxis_realtime_columns() from public, anon, authenticated;
grant  execute on function staxis_realtime_columns() to service_role;
