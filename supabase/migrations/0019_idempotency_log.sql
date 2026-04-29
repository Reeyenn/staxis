-- ═══════════════════════════════════════════════════════════════════════════
-- 0019 — Idempotency log (generic Stripe-style request dedup)
--
-- Pattern lifted from Stripe / Twilio:
--   Caller sends `Idempotency-Key: <uuid>` on POST.
--   Route looks up the key. Found AND fresh? Return the cached response.
--   Not found? Do the work, then write the key + response so a retry hits
--   the cache.
--
-- Why generic instead of per-route columns:
--   Several routes need this (send-shift-confirmations, morning-resend,
--   notify-housekeepers-sms, future SMS routes). One central log keeps
--   the policy consistent — same TTL, same cleanup story, same auditability.
--
-- TTL: 24 hours. Long enough to absorb a flaky client / retry storm,
-- short enough that the table doesn't grow forever. A nightly cleanup
-- prunes old rows; until that's wired, this stays small (Mario sends
-- ~10 confirmations per night = ~10 rows/day).
--
-- Service-role only via RLS — same model as accounts, applied_migrations,
-- scraper_credentials.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.idempotency_log (
  key            text primary key,
  route          text not null,
  -- The cached response we sent on the first successful call. JSON blob;
  -- routes are free to put whatever they want here as long as it round-trips
  -- through JSON.stringify.
  response       jsonb not null,
  status_code    integer not null default 200,
  -- Optional: ties the entry back to a property for cleanup or audit.
  property_id    uuid references public.properties(id) on delete cascade,
  created_at     timestamptz not null default now(),
  -- expires_at lets the cleanup job filter without subtraction.
  expires_at     timestamptz not null default (now() + interval '24 hours')
);

-- Cleanup helper. Cron job (or the route itself, opportunistically) calls
-- this. Idempotent. Returns deleted count for logging.
create or replace function public.cleanup_idempotency_log()
returns integer
language plpgsql
security definer
as $$
declare
  deleted_count integer;
begin
  delete from public.idempotency_log where expires_at < now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create index if not exists idempotency_log_expires_at_idx
  on public.idempotency_log (expires_at);

create index if not exists idempotency_log_route_created_idx
  on public.idempotency_log (route, created_at desc);

-- Service-role only.
alter table public.idempotency_log enable row level security;

drop policy if exists idempotency_log_deny_browser on public.idempotency_log;
create policy idempotency_log_deny_browser on public.idempotency_log
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.idempotency_log is
  'Generic Stripe-style request idempotency cache. Routes that send SMS or perform other expensive non-idempotent work look up the caller-supplied Idempotency-Key here before doing anything. 24h TTL.';

comment on function public.cleanup_idempotency_log() is
  'Deletes rows past expires_at. Called by nightly cron or opportunistically by routes. Returns deleted-row count.';

insert into public.applied_migrations (version, description)
values ('0019', 'Idempotency log (generic Stripe-style request dedup)')
on conflict (version) do nothing;
