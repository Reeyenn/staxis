-- ═══════════════════════════════════════════════════════════════════════════
-- 0242 — Laundry completion state (persist per-staff-per-day progress)
--
-- The public /laundry/[id] page tracked completed public-area tasks + laundry
-- loads in browser memory only (useState Sets). A page refresh, the midnight
-- date roll, or the 60s bootstrap poll wiped the whole shift's checkmarks —
-- the worker's done work looked undone. This table persists that progress.
--
-- Read/written ONLY via /api/laundry/* (service-role) with a (pid, staffId)
-- capability check — same public-surface model as the housekeeper routes.
--
-- @rls: service-role-only — accessed only via /api/* with supabaseAdmin;
--       RLS enabled with no anon/authenticated policies (deny-all).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.laundry_completion (
  property_id    uuid not null references public.properties(id) on delete cascade,
  staff_id       uuid not null references public.staff(id) on delete cascade,
  shift_date     date not null,
  -- Completed public-area task ids (public_areas.id).
  completed_area_ids        text[] not null default '{}',
  -- Completed laundry load CATEGORY names (not card index): the displayed
  -- load count changes through the day as the CUA updates checkout/stayover
  -- rooms, so keying completion by category keeps a checkmark stuck to its
  -- task even when the number of loads shifts.
  completed_load_categories text[] not null default '{}',
  updated_at     timestamptz not null default now(),
  primary key (property_id, staff_id, shift_date)
);

alter table public.laundry_completion enable row level security;

drop policy if exists laundry_completion_deny_browser on public.laundry_completion;
create policy laundry_completion_deny_browser on public.laundry_completion
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.laundry_completion is
  'Per-staff-per-day laundry checklist progress for the public /laundry/[id] page. Service-role only; read/written via /api/laundry/* with a (pid, staffId) capability check. Replaces browser-memory-only tracking that was wiped on refresh/midnight/poll.';

insert into public.applied_migrations (version, description)
values ('0242', 'Laundry completion state (persist per-staff-per-day progress)')
on conflict (version) do nothing;
