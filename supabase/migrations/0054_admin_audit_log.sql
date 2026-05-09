-- 0054_admin_audit_log.sql
-- Records every admin action (job retry, recipe regenerate, expense edit,
-- prospect status change, etc.) so when Reeyen has help or wants to look
-- back at "who clicked what when" he has a record.
--
-- Written from server-side admin routes via the service role.

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  actor_user_id uuid references auth.users(id) on delete set null,
  -- Denormalized so the log is still readable if the user is later deleted.
  actor_email text,
  -- Stable verb-style action name. Examples:
  --   'job.retry', 'recipe.regenerate', 'prospect.create',
  --   'prospect.update', 'expense.create', 'expense.delete',
  --   'feedback.resolve', 'roadmap.update'
  action text not null,
  -- 'property', 'job', 'recipe', 'prospect', 'expense', 'feedback', etc.
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists admin_audit_log_ts_idx on public.admin_audit_log (ts desc);
create index if not exists admin_audit_log_actor_idx on public.admin_audit_log (actor_user_id, ts desc);
create index if not exists admin_audit_log_action_idx on public.admin_audit_log (action, ts desc);

alter table public.admin_audit_log enable row level security;
