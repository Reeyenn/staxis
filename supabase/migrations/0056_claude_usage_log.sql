-- 0056_claude_usage_log.sql
-- Logs every Anthropic API call the system makes (CUA mapping/extraction,
-- ML dispatch, etc.) with token counts and cost. Source of truth for the
-- per-hotel "Claude API spend" row in the Money tab.
--
-- Cost is stored in micro-dollars (1e-6 USD) so cheap calls (~$0.0003)
-- don't round to zero. Rolled up into expenses.category='claude_api'
-- nightly so the Money tab always shows a single number.

create table if not exists public.claude_usage_log (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  property_id uuid references public.properties(id) on delete set null,
  -- e.g. 'cua_mapping', 'cua_extraction', 'ml_dispatch'
  workload text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_micros bigint not null default 0,
  -- Onboarding/pull job correlation if the call was inside a job. Nullable
  -- for ad-hoc calls (e.g., admin-triggered re-extracts).
  job_id uuid,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists claude_usage_log_ts_idx on public.claude_usage_log (ts desc);
create index if not exists claude_usage_log_property_idx on public.claude_usage_log (property_id, ts desc);
create index if not exists claude_usage_log_workload_idx on public.claude_usage_log (workload, ts desc);

alter table public.claude_usage_log enable row level security;
