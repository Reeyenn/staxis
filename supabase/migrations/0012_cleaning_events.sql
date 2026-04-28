-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Cleaning Events Audit Log (Migration 0012)
--
-- Adds a permanent, immutable per-clean audit log so the Housekeeping
-- Performance tab can compute averages, leaderboards, and trends across any
-- date range — independent of the live `rooms` table.
--
-- Why this exists:
--   The `rooms` table holds one row per (property, date, room_number) and is
--   re-cleaned by the scraper every day. That preserves yesterday's row on
--   yesterday's date — but it can't track:
--     • Multiple cleans on the same day (Mario resets a room mid-shift)
--     • Per-housekeeper attribution that survives reassignment
--     • A persistent flag-review queue (Mario's Yes/No decisions)
--     • Auto-discard of <3-min accidental clicks
--
--   `cleaning_events` is the dedicated source of truth for those concerns.
--
-- Lifecycle of a row:
--   • Inserted by the housekeeper page when "Done" is tapped (one row each).
--   • Status is computed at insert time:
--       duration_minutes < 3   → 'discarded' (excluded from averages forever)
--       duration_minutes > 60  → 'flagged'   (excluded until Mario reviews)
--       otherwise              → 'recorded'  (counted in averages)
--   • Mario reviews flagged entries → status flips to 'approved' or 'rejected'.
--   • Decision is permanent. Row is never updated otherwise.
--
-- Backfill:
--   Last 365 days of `rooms` rows with both started_at + completed_at are
--   seeded so the Performance tab has data on day one. Backfilled rows skip
--   the flag-review queue (everything > 60 min is recorded, not flagged) so
--   Mario isn't dumped with a year-old backlog. Going forward, real-time
--   inserts use the full rule set.
--
-- This migration is safe to re-run; the unique constraint + ON CONFLICT DO
-- NOTHING make backfill idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Status enum ─────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'cleaning_event_status') then
    create type cleaning_event_status as enum (
      'recorded',   -- normal clean, counted in averages
      'discarded',  -- auto-discarded (<3 min, accidental tap)
      'flagged',    -- needs Mario's review (>60 min)
      'approved',   -- Mario kept this entry
      'rejected'    -- Mario threw out this entry
    );
  end if;
end $$;

-- 2. Table ───────────────────────────────────────────────────────────────────
create table if not exists cleaning_events (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  date              date not null,                                  -- operational date
  room_number       text not null,                                  -- e.g. "414"
  room_type         text not null check (room_type in ('checkout','stayover')),
  stayover_day      integer,                                        -- 1=S1 (light), 2=S2 (full), null for checkouts
  staff_id          uuid references staff(id) on delete set null,
  staff_name        text not null,                                  -- snapshot at clean time
  started_at        timestamptz not null,
  completed_at      timestamptz not null,
  duration_minutes  numeric(8,2) not null check (duration_minutes >= 0),
  status            cleaning_event_status not null default 'recorded',
  flag_reason       text,                                           -- 'over_60min' etc.
  reviewed_by       uuid,                                           -- auth user id
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  -- Prevent duplicate inserts for the same (room, date, started_at, completed_at).
  -- Two legitimate cleans of the same room on the same day will have different
  -- started_at OR completed_at, so they remain distinct rows.
  constraint cleaning_events_unique unique (property_id, date, room_number, started_at, completed_at)
);

-- 3. Indexes ─────────────────────────────────────────────────────────────────
create index if not exists cleaning_events_property_date_idx
  on cleaning_events (property_id, date desc);

create index if not exists cleaning_events_staff_idx
  on cleaning_events (property_id, staff_id, date desc);

-- Partial index just for the flag-review queue — small, fast lookup.
create index if not exists cleaning_events_flagged_idx
  on cleaning_events (property_id, created_at desc)
  where status = 'flagged';

-- 4. RLS — owner read/write following the existing pattern ──────────────────
alter table cleaning_events enable row level security;

drop policy if exists "owner rw cleaning_events" on cleaning_events;
create policy "owner rw cleaning_events"
  on cleaning_events
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

-- 5. Realtime publication ───────────────────────────────────────────────────
-- Live tab subscribes to inserts so new cleans appear instantly on Mario's
-- Performance page without a page refresh.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'cleaning_events'
  ) then
    execute 'alter publication supabase_realtime add table public.cleaning_events';
  end if;
end $$;

alter table cleaning_events replica identity full;

-- 6. Backfill from rooms history (last 365 days) ────────────────────────────
-- Idempotent via ON CONFLICT — re-running this migration does nothing.
-- Backfilled rows are all 'recorded' (no flag review queue dump on Mario)
-- except for sub-3-min entries which are still discarded.
insert into cleaning_events (
  property_id, date, room_number, room_type, stayover_day,
  staff_id, staff_name, started_at, completed_at, duration_minutes, status
)
select
  r.property_id,
  r.date,
  r.number,
  r.type,
  case
    when r.type = 'stayover' and r.stayover_day is not null and r.stayover_day > 0
      then ((r.stayover_day - 1) % 2) + 1   -- 1,3,5… → 1; 2,4,6… → 2
    else null
  end as stayover_day_bucket,
  r.assigned_to,
  coalesce(nullif(trim(r.assigned_name), ''), 'Unknown') as staff_name,
  r.started_at,
  r.completed_at,
  round((extract(epoch from (r.completed_at - r.started_at)) / 60.0)::numeric, 2) as duration_minutes,
  case
    when extract(epoch from (r.completed_at - r.started_at)) / 60.0 < 3
      then 'discarded'::cleaning_event_status
    else 'recorded'::cleaning_event_status
  end as status
from rooms r
where r.started_at is not null
  and r.completed_at is not null
  and r.completed_at > r.started_at
  and r.type in ('checkout', 'stayover')
  and r.date >= current_date - interval '365 days'
on conflict (property_id, date, room_number, started_at, completed_at) do nothing;

-- 7. Audit-friendly comment block ────────────────────────────────────────────
comment on table  cleaning_events is 'Permanent audit log of every housekeeping clean event (one row per Done tap). Powers the Housekeeping Performance tab.';
comment on column cleaning_events.duration_minutes is 'completed_at - started_at, in minutes. Computed at insert time, never recomputed.';
comment on column cleaning_events.status           is 'recorded=in averages, discarded=under 3min, flagged=over 60min awaiting review, approved/rejected=Mario decided.';
comment on column cleaning_events.stayover_day     is 'Bucketed cycle: 1=S1 (odd day, light/15min), 2=S2 (even day, full/20min). Null for checkouts.';
