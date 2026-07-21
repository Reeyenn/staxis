-- 0332: Make staff contact and payroll privacy a database boundary.
--
-- Migration 0330 split roster reads from manage_team-gated writes, but RLS is
-- row-level: any authenticated member of a property could still ask PostgREST
-- for phone, phone_lookup, or hourly_wage on an otherwise-visible staff row.
-- Keep the operational roster readable for schedules and assignments while
-- requiring the manager-gated service routes for contacts and wages.

begin;

do $$
begin
  if to_regclass('public.staff') is null then
    raise exception '0332 requires public.staff';
  end if;
end
$$;

-- PostgreSQL checks column privileges before applying row-level policies.
-- property_id is required for tenant filters; the remaining columns exactly
-- match STAFF_COLS in src/lib/db/staff.ts. New staff columns therefore fail
-- closed until deliberately added to both allowlists.
revoke select on public.staff from public, anon, authenticated;
grant select (
  id, property_id, name, language, is_senior, department,
  scheduled_today, weekly_hours, max_weekly_hours, max_days_per_week,
  days_worked_this_week, vacation_dates, is_active, schedule_priority,
  last_paired_at
) on public.staff to authenticated;

-- Server routes authenticate and authorize the end user before using the
-- service client to hydrate contacts, wages, and server-internal link fields.
grant select on public.staff to service_role;

-- Deliberately do not change INSERT/UPDATE/DELETE privileges here. Migration
-- 0330's RLS policies keep browser mutations behind manage_team + MFA, while
-- service-role workflows retain their existing write access.

insert into public.applied_migrations (version, description)
values (
  '0332',
  'Restrict authenticated staff SELECT to operational roster columns; keep contacts, payroll, and internal identity fields service-only'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
