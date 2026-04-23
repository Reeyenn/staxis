-- Migration 0004 — pg_tables_rls_status view
--
-- Exposes pg_class.relrowsecurity to application code so /api/admin/doctor
-- can verify RLS is actually enabled on every user-facing table.
--
-- Why this matters:
--   - service_role (used by doctor) BYPASSES RLS by design. So you cannot
--     detect "RLS accidentally disabled" from a normal query — the results
--     look identical whether RLS is on or off.
--   - This view surfaces the raw pg_catalog state so the doctor can catch
--     `ALTER TABLE … DISABLE ROW LEVEL SECURITY` before it turns into a
--     PII leak.
--
-- The view itself is security-definer: it runs as the migration owner so
-- even an unprivileged caller can read the RLS state. But we restrict SELECT
-- to authenticated + service_role so anon users can't enumerate schema.

create or replace view public.pg_tables_rls_status as
  select
    c.relname       as tablename,
    n.nspname       as schemaname,
    c.relrowsecurity as rowsecurity,
    c.relforcerowsecurity as forcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r'           -- ordinary tables only
    and n.nspname = 'public';

-- Lock down who can read it. service_role always can (bypasses grants).
revoke all on public.pg_tables_rls_status from public;
grant select on public.pg_tables_rls_status to authenticated;

comment on view public.pg_tables_rls_status is
  'RLS enablement status for every public table. Read by /api/admin/doctor.';
