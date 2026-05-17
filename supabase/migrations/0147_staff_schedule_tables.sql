-- Migration 0147: weekly schedule data model
--
-- Adds four tables that back the new /staff manager-side week grid +
-- staff-side My Shifts view:
--
--   property_shift_presets — manager-defined named shifts per dept
--     ("Morning HK: 8a–4p", "Front desk overnight: 11p–7a", …). The
--     week grid cell-edit popover offers these as one-click picks; the
--     manager can still type a free-form override.
--
--   scheduled_shifts — one row per assigned cell on the week grid, plus
--     one row per "open" cell waiting to be picked up. Replaces the
--     read-only display previously derived from shift_confirmations.
--     A staff member who confirms tomorrow's SMS still gets a
--     shift_confirmations row (that flow is unchanged); we also seed a
--     scheduled_shifts row so the grid stays the source of truth.
--
--   time_off_requests — staff-submitted requests; manager approves /
--     denies in the week grid popover. On approve the matching
--     scheduled_shifts row is auto-removed and the AI tomorrow-picks
--     flow treats that date as a vacation day for that staff member.
--     In-app only — no SMS notifications, per product call 2026-05-17.
--
--   week_publications — bookkeeping for "this week is published". My
--     Shifts (staff view) only shows shifts inside a published week,
--     so staff don't see Maria mid-edit. Re-publishing stamps a new
--     row (we keep the history for audit / "who published when").
--
-- All tables: RLS on, only the property's owner/GM/admin can mutate
-- (writes go through API routes that use supabaseAdmin). The
-- *_self_select policies let logged-in staff read their own rows for
-- the My Shifts view.

set local lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Shift presets — named shift templates per (property, dept).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.property_shift_presets (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  name         text not null,
  department   text not null check (department in ('housekeeping','front_desk','maintenance','other')),
  start_time   time not null,
  end_time     time not null,
  sort_order   int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_property_shift_presets_property
  on public.property_shift_presets(property_id, department, sort_order);
alter table public.property_shift_presets enable row level security;
-- Anyone with property_access can read presets (the picker on staff view
-- needs them too, since open-shift cards show the shift's time).
create policy property_shift_presets_select
  on public.property_shift_presets for select to authenticated
  using (public.user_owns_property(property_id));
create policy property_shift_presets_deny_writes
  on public.property_shift_presets for all to authenticated
  using (false) with check (false);


-- ─────────────────────────────────────────────────────────────────────────
-- 2. Scheduled shifts — the canonical week-grid table.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.scheduled_shifts (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  -- staff_id is nullable so we can also represent an "open" cell (staff
  -- TBD, dept known). Once someone picks it up we update staff_id and
  -- flip kind to 'shift'.
  staff_id      uuid references public.staff(id) on delete set null,
  department    text not null check (department in ('housekeeping','front_desk','maintenance','other')),
  shift_date    date not null,
  start_time    time not null,
  end_time      time not null,
  -- 'shift' = a real assigned shift; 'open' = an unfilled slot any
  -- eligible staff can pick up.
  kind          text not null default 'shift' check (kind in ('shift','open')),
  -- 'draft' = manager building the week, not yet visible to staff.
  -- 'published' = visible to staff in My Shifts.
  -- 'sent' / 'confirmed' / 'declined' mirror shift_confirmations so the
  -- grid can color cells by SMS state once tomorrow's texts go out.
  status        text not null default 'draft'
                check (status in ('draft','published','sent','confirmed','declined')),
  preset_id     uuid references public.property_shift_presets(id) on delete set null,
  -- Why this cell is open (e.g. "Brenda declined", "extra coverage").
  -- Shown in the staff-side pickup card.
  reason        text,
  -- Who originally filled this slot before bailing. Used to populate the
  -- "Open shift from Brenda" copy in the staff pickup card.
  filled_by_history jsonb not null default '[]'::jsonb,
  -- Optional free-form note (manager-attached) — surfaces as a dot in the
  -- week grid cell. Not the same as `reason` (which is for open shifts).
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One assigned shift per (property, staff, date). Open shifts can stack
  -- (multiple uncovered slots on same date), so the unique only fires when
  -- staff_id is set and kind = 'shift'.
  constraint scheduled_shifts_one_per_staff_per_day
    exclude using btree (property_id with =, staff_id with =, shift_date with =)
    where (kind = 'shift' and staff_id is not null)
);
create index if not exists idx_scheduled_shifts_property_date
  on public.scheduled_shifts(property_id, shift_date);
create index if not exists idx_scheduled_shifts_staff_date
  on public.scheduled_shifts(staff_id, shift_date)
  where staff_id is not null;
create index if not exists idx_scheduled_shifts_open
  on public.scheduled_shifts(property_id, department, shift_date)
  where kind = 'open';
alter table public.scheduled_shifts enable row level security;
-- All authenticated users at the property can read. Staff need this for
-- their own My Shifts view + the open-shifts pickup card.
create policy scheduled_shifts_select
  on public.scheduled_shifts for select to authenticated
  using (public.user_owns_property(property_id));
create policy scheduled_shifts_deny_writes
  on public.scheduled_shifts for all to authenticated
  using (false) with check (false);


-- ─────────────────────────────────────────────────────────────────────────
-- 3. Time-off requests — staff submits, manager decides in-app.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.time_off_requests (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  staff_id      uuid not null references public.staff(id) on delete cascade,
  request_date  date not null,
  reason        text,
  status        text not null default 'pending'
                check (status in ('pending','approved','denied','cancelled')),
  submitted_at  timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references public.accounts(id) on delete set null,
  deny_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_time_off_requests_property_status
  on public.time_off_requests(property_id, status, request_date);
create index if not exists idx_time_off_requests_staff
  on public.time_off_requests(staff_id, request_date);
alter table public.time_off_requests enable row level security;
create policy time_off_requests_select
  on public.time_off_requests for select to authenticated
  using (public.user_owns_property(property_id));
create policy time_off_requests_deny_writes
  on public.time_off_requests for all to authenticated
  using (false) with check (false);


-- ─────────────────────────────────────────────────────────────────────────
-- 4. Week publications — which weeks are published vs draft.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.week_publications (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  week_start    date not null,  -- Monday of the week
  published_at  timestamptz not null default now(),
  published_by  uuid references public.accounts(id) on delete set null,
  -- Each Publish click stamps a new row; latest row wins. We keep the
  -- history so we can show "last published Tue 2:14p by Maria" in the UI.
  created_at    timestamptz not null default now()
);
create index if not exists idx_week_publications_property_week
  on public.week_publications(property_id, week_start desc, published_at desc);
alter table public.week_publications enable row level security;
create policy week_publications_select
  on public.week_publications for select to authenticated
  using (public.user_owns_property(property_id));
create policy week_publications_deny_writes
  on public.week_publications for all to authenticated
  using (false) with check (false);


-- ─────────────────────────────────────────────────────────────────────────
-- 5. updated_at triggers — reuse the existing trigger function from
--    earlier migrations (staxis_touch_updated_at).
-- ─────────────────────────────────────────────────────────────────────────
drop trigger if exists trg_property_shift_presets_touch on public.property_shift_presets;
create trigger trg_property_shift_presets_touch
  before update on public.property_shift_presets
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_scheduled_shifts_touch on public.scheduled_shifts;
create trigger trg_scheduled_shifts_touch
  before update on public.scheduled_shifts
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_time_off_requests_touch on public.time_off_requests;
create trigger trg_time_off_requests_touch
  before update on public.time_off_requests
  for each row execute function public.touch_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- 6. Realtime publication — staff My Shifts view + manager week grid
--    both subscribe; broadcast inserts/updates/deletes.
-- ─────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- ALTER PUBLICATION fails if a table is already a member, so probe first.
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scheduled_shifts'
    ) then
      execute 'alter publication supabase_realtime add table public.scheduled_shifts';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'time_off_requests'
    ) then
      execute 'alter publication supabase_realtime add table public.time_off_requests';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'property_shift_presets'
    ) then
      execute 'alter publication supabase_realtime add table public.property_shift_presets';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'week_publications'
    ) then
      execute 'alter publication supabase_realtime add table public.week_publications';
    end if;
  end if;
end $$;
