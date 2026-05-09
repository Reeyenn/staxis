-- 0050_prospects.sql
-- Sales pipeline: hotels Reeyen has talked to but haven't signed up yet.
-- Surfaced on the Onboarding tab as "Soon to be onboarded" with a per-hotel
-- launch checklist. Admin-only — service role bypasses RLS, no public access.

create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  hotel_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  pms_type text,
  expected_launch_date date,
  status text not null default 'talking'
    check (status in ('talking','negotiating','committed','onboarded','dropped')),
  notes text,
  -- Per-prospect launch checklist. Initial keys:
  --   pmsCredsCollected, staffListReady, gmTrained, launchDateConfirmed
  -- JSONB so we can iterate the shape without migrations.
  checklist jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prospects_status_idx on public.prospects (status);
create index if not exists prospects_created_idx on public.prospects (created_at desc);

alter table public.prospects enable row level security;
-- No policies on purpose: only the service role (admin API routes) reads/writes.

-- Generic updated_at trigger function. Re-used by other admin tables that
-- want PATCH semantics (roadmap_items, etc.).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists prospects_set_updated_at on public.prospects;
create trigger prospects_set_updated_at
  before update on public.prospects
  for each row
  execute function public.set_updated_at();
