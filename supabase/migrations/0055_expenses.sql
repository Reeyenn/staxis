-- 0055_expenses.sql
-- Expense ledger for the Money tab. Two flavors:
--   - manual: Reeyen types in "I spent $200 on hosting" via the UI
--   - auto:   instrumented spend (Claude API usage rolled up daily, etc.)
--
-- Per-hotel allocation via property_id (nullable — fleet-level expenses
-- like Vercel/Supabase don't have a single property).

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  category text not null
    check (category in (
      'claude_api','hosting','twilio','supabase','vercel','fly','other'
    )),
  amount_cents integer not null,
  description text,
  vendor text,
  -- Date the spend applies to (used for monthly aggregation). For
  -- recurring monthly bills, this is the first day of the period.
  incurred_on date not null,
  source text not null default 'manual'
    check (source in ('auto','manual')),
  -- Optional per-hotel attribution. Fleet-level expenses leave this null.
  property_id uuid references public.properties(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists expenses_incurred_idx on public.expenses (incurred_on desc);
create index if not exists expenses_category_idx on public.expenses (category, incurred_on desc);
create index if not exists expenses_property_idx on public.expenses (property_id, incurred_on desc);

alter table public.expenses enable row level security;
