-- 0320 — payment_history: every real charge for running Staxis.
--
-- Owner ask 2026-07-18: "get the whole history of me paying for everything."
-- One row per real receipt (swept from his Gmail 2026-07-18, back to Dec
-- 2025). The Money tab's History section and Total-paid hero read this;
-- the scheduled bookkeeper session appends new receipts as they arrive.
--
-- @rls: service-role-only — admin Money tab reads via /api/admin/money/
-- tech-stack (supabaseAdmin); the bookkeeper writes via psql. No anon or
-- authenticated access: RLS enabled with no policies = deny-all.

create table if not exists public.payment_history (
  id           uuid primary key default gen_random_uuid(),
  paid_on      date not null,
  vendor       text not null,
  description  text,
  amount_cents integer not null check (amount_cents >= 0),
  source       text not null default 'receipt',
  created_at   timestamptz not null default now(),
  -- One row per real-world charge: same day + vendor + amount = same charge
  -- (the bookkeeper re-sweeps overlapping windows; this makes inserts
  -- idempotent via ON CONFLICT DO NOTHING).
  unique (paid_on, vendor, amount_cents)
);

create index if not exists payment_history_paid_on_idx
  on public.payment_history (paid_on desc);

alter table public.payment_history enable row level security;

insert into public.applied_migrations (version, description)
values ('0320', 'payment_history: real receipt-backed charges powering the Money tab history + total paid')
on conflict (version) do nothing;
