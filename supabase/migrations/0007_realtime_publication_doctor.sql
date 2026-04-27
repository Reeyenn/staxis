-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Doctor visibility into the supabase_realtime publication
--
-- Why this migration:
--   /api/admin/doctor needs to verify every table the app subscribes to via
--   Supabase Realtime is actually IN the supabase_realtime publication. We
--   already hit the bug where it was empty (silently broke every realtime
--   subscription for hours after the Firebase migration). The doctor needs
--   to surface this state so a future fresh-project deploy can't repeat it.
--
--   pg_publication_tables is in the pg_catalog schema and isn't queryable
--   by Postgrest's table introspection — so direct supabase.from() doesn't
--   work. This migration adds:
--
--     1. A SECURITY DEFINER function `staxis_realtime_publication_tables()`
--        that the doctor calls via supabaseAdmin.rpc(). Returns a list of
--        every table currently in the supabase_realtime publication.
--
--     2. A defensive view `pg_publication_tables_view` in the public schema
--        as a fallback the doctor tries if the RPC isn't there yet.
--
-- Both paths are read-only and require the service_role key (the doctor
-- already runs with it).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. RPC function (preferred path) ───────────────────────────────────────────
create or replace function public.staxis_realtime_publication_tables()
returns table (tablename text)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select t.tablename::text
  from pg_publication_tables t
  where t.pubname = 'supabase_realtime'
    and t.schemaname = 'public';
$$;

-- Allow the service_role to call it. anon and authenticated should not.
revoke all on function public.staxis_realtime_publication_tables() from public;
grant execute on function public.staxis_realtime_publication_tables() to service_role;

-- 2. Read-only view (fallback path) ──────────────────────────────────────────
-- Some service_role contexts can't grant access to pg_catalog; expose a
-- minimal view that lives in the public schema and only includes the
-- (pubname, schemaname, tablename) triple.
create or replace view public.pg_publication_tables_view as
  select pubname::text, schemaname::text, tablename::text
  from pg_publication_tables
  where schemaname = 'public';

revoke all on public.pg_publication_tables_view from public;
grant select on public.pg_publication_tables_view to service_role;
