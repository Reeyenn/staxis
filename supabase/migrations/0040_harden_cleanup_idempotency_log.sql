-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0040: harden cleanup_idempotency_log() with pinned search_path
--
-- Bug found in audit pass on 2026-05-08:
--   public.cleanup_idempotency_log() (added in 0019) is SECURITY DEFINER
--   without an explicit `set search_path`. That makes it exploitable via
--   schema-shadowing — a user with CREATE on any schema in the search_path
--   could shadow `public.idempotency_log` with their own table and trick
--   the function (running with definer privileges) into deleting from it.
--
--   The repo has the same hardening pattern on 0036 / 0037 for the same
--   class of issue — this one was missed when 0019 landed. Re-create the
--   function with `set search_path = pg_catalog, public` to match.
--
--   No schema change, no data migration. Idempotent (CREATE OR REPLACE).
--   Safe to apply on a live DB.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.cleanup_idempotency_log()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted_count integer;
begin
  delete from public.idempotency_log where expires_at < now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

comment on function public.cleanup_idempotency_log() is
  'Deletes rows past expires_at. Called by nightly cron or opportunistically by routes. Returns deleted-row count. search_path pinned (0040) to prevent schema-shadowing attacks against the SECURITY DEFINER context.';

insert into public.applied_migrations (version, description)
values ('0040', 'Harden cleanup_idempotency_log search_path')
on conflict (version) do nothing;
