-- 0057_github_events.sql
-- Receives GitHub webhook events (push / pull_request / create / delete)
-- so the admin System tab can react to repo activity in seconds instead
-- of waiting for the next 10s polling cycle.
--
-- The client polls a tiny "what's the newest event timestamp?" endpoint
-- every 2 seconds. When it sees a new ts, it refetches build-status —
-- which then gets a fresh response because the webhook handler also
-- calls revalidateTag('github-data') to invalidate the server cache.

create table if not exists public.github_events (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  -- Common types: 'push', 'pull_request', 'create', 'delete', 'ping'
  event_type text not null,
  -- Branch ref if applicable (e.g. 'refs/heads/main' or 'refs/heads/feature/x')
  branch text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists github_events_ts_idx on public.github_events (ts desc);

alter table public.github_events enable row level security;
-- Service-role only (webhook + admin reader use supabaseAdmin).
