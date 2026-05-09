-- 0053_roadmap_items.sql
-- Reeyen's personal product TODO. Lives on the System tab so the admin
-- doubles as his command center: "what am I building next, what's done."
-- Admin-only — service role bypasses RLS, no public access.

create table if not exists public.roadmap_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  status text not null default 'idea'
    check (status in ('idea','planned','in_progress','done','dropped')),
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);

create index if not exists roadmap_items_status_idx on public.roadmap_items (status, priority desc);

alter table public.roadmap_items enable row level security;

-- Reuse the trigger function defined in 0050.
drop trigger if exists roadmap_items_set_updated_at on public.roadmap_items;
create trigger roadmap_items_set_updated_at
  before update on public.roadmap_items
  for each row
  execute function public.set_updated_at();
