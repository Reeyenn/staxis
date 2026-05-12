-- 0074_cron_heartbeats.sql
-- One row per cron workflow. Each cron route writes its name + a fresh
-- last_success_at after a successful pass; the doctor reads back and
-- fails when any heartbeat is older than 2× its expected cadence.
--
-- Replaces the implicit "GH Actions workflow list said it ran" signal,
-- which doesn't catch:
--   - Workflow ran but every per-property item errored (the silent-
--     success bug class — see ml-cron.yml jq check).
--   - GitHub auto-disabled the workflow after 60 days of repo inactivity.
--   - The route 200'd but didn't reach the heartbeat write (e.g. a
--     thrown error from a downstream Supabase call that got caught and
--     returned ok:true).
--
-- The heartbeat is the LAST thing each cron route does, after every
-- write that matters. If it lands, the cron really finished its job.

create table if not exists public.cron_heartbeats (
  cron_name        text primary key,
  last_success_at  timestamptz not null default now(),
  last_request_id  text,
  -- Optional payload — counts of items processed, etc. Useful when
  -- triaging "the cron ran but did nothing" cases.
  notes            jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);

comment on table public.cron_heartbeats is
  'One row per cron. Last_success_at is bumped at the end of every successful run. Read by /api/admin/doctor cron_heartbeats_fresh check to detect silently-broken workflows.';

comment on column public.cron_heartbeats.cron_name is
  'Stable identifier for the workflow — matches the GitHub Actions file basename (e.g. "ml-train-demand", "seal-daily", "scraper-health"). Used as the doctor check key.';

-- Service-role-only writes. UI surfaces read via admin endpoints, never
-- directly.
alter table public.cron_heartbeats enable row level security;

drop policy if exists cron_heartbeats_deny_browser on public.cron_heartbeats;
create policy cron_heartbeats_deny_browser on public.cron_heartbeats
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- updated_at trigger (mirrors the pattern in 0001).
create or replace function public.touch_cron_heartbeats_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cron_heartbeats_touch_updated_at on public.cron_heartbeats;
create trigger cron_heartbeats_touch_updated_at
  before update on public.cron_heartbeats
  for each row
  execute function public.touch_cron_heartbeats_updated_at();

insert into public.applied_migrations (version, description)
values ('0074', 'cron_heartbeats table for doctor liveness checks')
on conflict (version) do nothing;
