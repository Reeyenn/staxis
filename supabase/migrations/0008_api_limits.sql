-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Per-property hourly rate limits
--
-- Why this migration:
--   Pre-launch audit (2026-04-27) found every SMS-firing endpoint had zero
--   rate limit. A single attacker — or a single buggy client tab — could
--   fire thousands of SMS in a minute and drain the Twilio account in
--   hours ($7.50/min worst case at toll-free pricing). Need a hard cap
--   per (pid, endpoint, hour) before launch.
--
-- Design:
--   - One row per (property_id, endpoint, hour_bucket) tracking count.
--   - hour_bucket is a 13-char ISO prefix like "2026-04-27T17" so it
--     groups naturally per UTC hour and rolls over without TTL plumbing.
--   - Atomic increment via the SECURITY DEFINER RPC below — two concurrent
--     requests can't both squeak under the cap.
--   - Old rows are pruned by a separate scheduled job (digest cron will
--     do it).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.api_limits (
  property_id  uuid    not null,
  endpoint     text    not null,
  hour_bucket  text    not null,
  count        integer not null default 0,
  primary key (property_id, endpoint, hour_bucket)
);

-- RLS off — the rate limit table is server-side only, written by the
-- service-role API code path. anon / authenticated users never touch it.
alter table public.api_limits enable row level security;
revoke all on public.api_limits from public, anon, authenticated;
grant select, insert, update on public.api_limits to service_role;

-- Atomic hit: increment count for the (pid, endpoint, hour) tuple, return
-- new value. Returns 1 on first hit, 2, 3, … so the caller can compare
-- directly against its per-endpoint cap.
create or replace function public.staxis_api_limit_hit(
  p_property_id uuid,
  p_endpoint    text,
  p_hour_bucket text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count integer;
begin
  insert into public.api_limits (property_id, endpoint, hour_bucket, count)
  values (p_property_id, p_endpoint, p_hour_bucket, 1)
  on conflict (property_id, endpoint, hour_bucket)
  do update set count = api_limits.count + 1
  returning count into v_count;
  return v_count;
end;
$$;

revoke all on function public.staxis_api_limit_hit(uuid, text, text) from public, anon, authenticated;
grant execute on function public.staxis_api_limit_hit(uuid, text, text) to service_role;

-- Cleanup helper: drop any row whose hour_bucket is more than 48h old.
-- Called by the weekly-digest cron after the digest runs.
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
