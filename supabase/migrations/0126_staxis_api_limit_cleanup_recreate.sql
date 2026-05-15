-- Round 16 (2026-05-15): repair migration drift on staxis_api_limit_cleanup.
--
-- Background: migration 0008_api_limits.sql defines two functions —
-- staxis_api_limit_hit (used by every limited route) and
-- staxis_api_limit_cleanup (called hourly by /api/cron/purge-old-error-logs).
-- The _hit function was created when 0008 first shipped (pre-migration-
-- tracker), so 0076_backfill_applied_migrations.sql later registered 0008
-- as "applied". The _cleanup half was appended to 0008 AFTER that backfill
-- — meaning prod has _hit but not _cleanup, and every run of the purge
-- cron logs to Sentry:
--
--   Could not find the function public.staxis_api_limit_cleanup
--   without parameters in the schema cache
--
-- This migration re-emits the _cleanup definition so it lands in prod.
-- The body is character-identical to 0008's appended block; create or
-- replace makes it idempotent for any env where it already exists.

create or replace function public.staxis_api_limit_cleanup()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_cutoff text;
  v_deleted integer;
begin
  v_cutoff := to_char(now() at time zone 'UTC' - interval '48 hours', 'YYYY-MM-DD"T"HH24');
  delete from public.api_limits where hour_bucket < v_cutoff;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.staxis_api_limit_cleanup() from public, anon, authenticated;
grant execute on function public.staxis_api_limit_cleanup() to service_role;

insert into public.applied_migrations (version, description)
values ('0126', 'recreate staxis_api_limit_cleanup() — repair 0008 drift (purge-old-error-logs cron)')
on conflict (version) do nothing;
