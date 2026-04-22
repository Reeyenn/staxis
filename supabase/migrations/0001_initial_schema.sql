-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Initial Postgres schema
-- Migration from Firebase/Firestore → Supabase (Postgres + Realtime + Auth)
--
-- Design principles:
--   • Mirror existing Firestore shapes exactly so migration is mechanical.
--   • Use uuid PKs (Supabase convention) + text IDs for room-like natural keys.
--   • All timestamps are timestamptz.
--   • jsonb for nested "room details" arrays and the roomAssignments map.
--   • text[] for room-number arrays (checkoutRoomNumbers, etc.).
--   • RLS enabled on every table. Policies at bottom of file.
--   • Indexes on (property_id, date) + (property_id, created_at desc) because
--     those are the two access patterns used everywhere.
-- ═══════════════════════════════════════════════════════════════════════════

-- Extensions ────────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";   -- for gen_random_uuid()
create extension if not exists "uuid-ossp";

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. PROPERTIES
-- Replaces: users/{uid}/properties/{pid}
-- Owner is auth.users.id (Supabase auth). A user can have multiple properties.
-- ═══════════════════════════════════════════════════════════════════════════
create table properties (
  id                          uuid primary key default gen_random_uuid(),
  owner_id                    uuid not null references auth.users(id) on delete cascade,
  name                        text not null,
  total_rooms                 integer not null default 0,
  avg_occupancy               numeric not null default 0,
  hourly_wage                 numeric not null default 15,
  checkout_minutes            integer not null default 30,
  stayover_minutes            integer not null default 20,   -- legacy fallback
  stayover_day1_minutes       integer default 15,            -- light clean
  stayover_day2_minutes       integer default 20,            -- full clean
  prep_minutes_per_activity   integer not null default 5,
  shift_minutes               integer not null default 480,
  total_staff_on_roster       integer not null default 0,
  weekly_budget               numeric,
  morning_briefing_time       text,
  evening_forecast_time       text,
  pms_type                    text,
  pms_url                     text,
  pms_connected               boolean default false,
  last_synced_at              timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index properties_owner_id_idx on properties (owner_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ACCOUNTS (username/password login table)
-- Replaces: accounts collection. Maps a username to an auth.users row via
-- data_user_id. The /api/auth/login route looks up by username, verifies
-- bcrypt, then returns a Supabase session for the linked data_user_id.
-- ═══════════════════════════════════════════════════════════════════════════
create table accounts (
  id                uuid primary key default gen_random_uuid(),
  username          text not null unique,
  password_hash     text not null,
  display_name      text not null,
  role              text not null default 'manager',       -- 'admin' | 'manager' | 'viewer'
  property_access   uuid[] not null default '{}',          -- array of property ids this account can access
  data_user_id      uuid not null references auth.users(id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index accounts_username_idx on accounts (username);
create index accounts_data_user_id_idx on accounts (data_user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. STAFF
-- Replaces: properties/{pid}/staff
-- ═══════════════════════════════════════════════════════════════════════════
create table staff (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references properties(id) on delete cascade,
  name                     text not null,
  phone                    text,
  phone_lookup             text,                              -- normalized phone for reverse lookup
  language                 text not null default 'en' check (language in ('en','es')),
  is_senior                boolean not null default false,
  department               text default 'housekeeping' check (department in ('housekeeping','front_desk','maintenance','other')),
  hourly_wage              numeric,
  scheduled_today          boolean not null default false,
  weekly_hours             numeric not null default 0,
  max_weekly_hours         numeric not null default 40,
  max_days_per_week        integer default 5,
  days_worked_this_week    integer default 0,
  vacation_dates           text[] default '{}',              -- YYYY-MM-DD strings
  is_active                boolean default true,
  schedule_priority        text check (schedule_priority in ('priority','normal','excluded')),
  is_scheduling_manager    boolean default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index staff_property_id_idx on staff (property_id);
create index staff_phone_lookup_idx on staff (phone_lookup);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ROOMS
-- Replaces: properties/{pid}/rooms
-- Each doc is one room on one date. Composite key (property_id, date, number).
-- ═══════════════════════════════════════════════════════════════════════════
create table rooms (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  number            text not null,
  date              date not null,
  type              text not null check (type in ('checkout','stayover','vacant')),
  priority          text not null default 'standard' check (priority in ('standard','vip','early')),
  status            text not null default 'dirty' check (status in ('dirty','in_progress','clean','inspected')),
  assigned_to       uuid references staff(id) on delete set null,
  assigned_name     text,
  started_at        timestamptz,
  completed_at      timestamptz,
  issue_note        text,
  inspected_by      text,
  inspected_at      timestamptz,
  is_dnd            boolean default false,
  dnd_note          text,
  arrival           text,                           -- guest arrival date "M/D/YY" from CSV
  stayover_day      integer,                        -- 0=arrival, 1=light, 2=full, …
  stayover_minutes  integer,                        -- 0, 15, 20
  help_requested    boolean default false,
  checklist         jsonb,                          -- { itemKey: bool } checklist
  photo_url         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (property_id, date, number)
);

create index rooms_property_date_idx on rooms (property_id, date);
create index rooms_property_date_status_idx on rooms (property_id, date, status);
create index rooms_assigned_to_idx on rooms (assigned_to);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. PUBLIC AREAS
-- Replaces: properties/{pid}/publicAreas
-- ═══════════════════════════════════════════════════════════════════════════
create table public_areas (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references properties(id) on delete cascade,
  name               text not null,
  floor              text not null,
  locations          integer not null default 1,
  frequency_days     integer not null,
  minutes_per_clean  integer not null,
  start_date         date not null,
  only_when_rented   boolean default false,
  is_rented_today    boolean default false,
  created_at         timestamptz not null default now()
);

create index public_areas_property_id_idx on public_areas (property_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. LAUNDRY CONFIG
-- Replaces: properties/{pid}/laundryConfig
-- ═══════════════════════════════════════════════════════════════════════════
create table laundry_config (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  name                  text not null,
  units_per_checkout    numeric not null default 0,
  two_bed_multiplier    numeric not null default 1,
  stayover_factor       numeric not null default 0,
  room_equivs_per_load  numeric not null default 1,
  minutes_per_load      integer not null default 60,
  created_at            timestamptz not null default now()
);

create index laundry_config_property_id_idx on laundry_config (property_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. DAILY LOGS
-- Replaces: properties/{pid}/dailyLogs/{date}
-- ═══════════════════════════════════════════════════════════════════════════
create table daily_logs (
  id                        uuid primary key default gen_random_uuid(),
  property_id               uuid not null references properties(id) on delete cascade,
  date                      date not null,
  occupied                  integer,
  checkouts                 integer,
  two_bed_checkouts         integer,
  stayovers                 integer,
  vips                      integer,
  early_checkins            integer,
  room_minutes              integer,
  public_area_minutes       integer,
  laundry_minutes           integer,
  total_minutes             integer,
  recommended_staff         numeric,
  actual_staff              numeric,
  hourly_wage               numeric,
  labor_cost                numeric,
  labor_saved               numeric,
  start_time                text,
  completion_time           text,
  public_areas_due_today    text[] default '{}',
  laundry_loads             jsonb,                   -- { towels, sheets, comforters }
  rooms_completed           integer,
  avg_turnaround_minutes    integer,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (property_id, date)
);

create index daily_logs_property_date_idx on daily_logs (property_id, date);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. WORK ORDERS (maintenance)
-- Replaces: properties/{pid}/workOrders
-- ═══════════════════════════════════════════════════════════════════════════
create table work_orders (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references properties(id) on delete cascade,
  room_number            text not null,
  description            text not null,
  severity               text not null check (severity in ('low','medium','urgent')),
  status                 text not null check (status in ('submitted','assigned','in_progress','resolved')),
  submitted_by           text,
  submitted_by_name      text,
  assigned_to            uuid references staff(id) on delete set null,
  assigned_name          text,
  photo_url              text,
  notes                  text,
  blocked_room           boolean default false,
  source                 text check (source in ('manual','housekeeper','ca_ooo')),
  ca_work_order_number   text,
  ca_from_date           text,
  ca_to_date             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  resolved_at            timestamptz
);

create index work_orders_property_status_idx on work_orders (property_id, status);
create index work_orders_property_created_idx on work_orders (property_id, created_at desc);
create unique index work_orders_ca_dedup_idx on work_orders (property_id, ca_work_order_number)
  where ca_work_order_number is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. PREVENTIVE TASKS
-- Replaces: properties/{pid}/preventiveTasks
-- ═══════════════════════════════════════════════════════════════════════════
create table preventive_tasks (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  name                  text not null,
  frequency_days        integer not null,
  last_completed_at     timestamptz,
  last_completed_by     text,
  notes                 text,
  created_at            timestamptz not null default now()
);

create index preventive_tasks_property_id_idx on preventive_tasks (property_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. LANDSCAPING TASKS
-- Replaces: properties/{pid}/landscapingTasks
-- ═══════════════════════════════════════════════════════════════════════════
create table landscaping_tasks (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  name                  text not null,
  season                text not null check (season in ('year-round','spring','summer','fall','winter')),
  frequency_days        integer not null,
  last_completed_at     timestamptz,
  last_completed_by     text,
  notes                 text,
  created_at            timestamptz not null default now()
);

create index landscaping_tasks_property_id_idx on landscaping_tasks (property_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. INVENTORY
-- Replaces: properties/{pid}/inventory
-- ═══════════════════════════════════════════════════════════════════════════
create table inventory (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references properties(id) on delete cascade,
  name                    text not null,
  category                text not null check (category in ('housekeeping','maintenance','breakfast')),
  current_stock           numeric not null default 0,
  par_level               numeric not null default 0,
  reorder_at              numeric,
  unit                    text not null,
  notes                   text,
  usage_per_checkout      numeric,
  usage_per_stayover      numeric,
  reorder_lead_days       integer default 3,
  vendor_name             text,
  last_ordered_at         timestamptz,
  updated_at              timestamptz not null default now()
);

create index inventory_property_category_idx on inventory (property_id, category);

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. INSPECTIONS
-- Replaces: properties/{pid}/inspections
-- ═══════════════════════════════════════════════════════════════════════════
create table inspections (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  name                  text not null,
  due_month             text not null,               -- "YYYY-MM"
  frequency_months      integer not null,            -- legacy
  frequency_days        integer,                     -- canonical when set
  last_inspected_date   date,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index inspections_property_id_idx on inspections (property_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. HANDOFF LOGS
-- Replaces: properties/{pid}/handoffLogs
-- ═══════════════════════════════════════════════════════════════════════════
create table handoff_logs (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  shift_type          text not null check (shift_type in ('morning','afternoon','night')),
  author              text not null,
  notes               text not null,
  acknowledged        boolean not null default false,
  acknowledged_by     text,
  acknowledged_at     timestamptz,
  created_at          timestamptz not null default now()
);

create index handoff_logs_property_created_idx on handoff_logs (property_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. GUEST REQUESTS
-- Replaces: properties/{pid}/guestRequests
-- ═══════════════════════════════════════════════════════════════════════════
create table guest_requests (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  room_number       text not null,
  type              text not null check (type in ('towels','pillows','blanket','iron','crib','toothbrush','amenities','maintenance','other')),
  notes             text,
  status            text not null default 'pending' check (status in ('pending','in_progress','done')),
  assigned_to       uuid references staff(id) on delete set null,
  assigned_name     text,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index guest_requests_property_created_idx on guest_requests (property_id, created_at desc);
create index guest_requests_property_status_idx on guest_requests (property_id, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. SHIFT CONFIRMATIONS
-- Replaces: properties/{pid}/shiftConfirmations
-- The "token" was the Firestore doc ID. Here it's a separate column but unique.
-- ═══════════════════════════════════════════════════════════════════════════
create table shift_confirmations (
  token           text primary key,
  property_id     uuid not null references properties(id) on delete cascade,
  staff_id        uuid not null references staff(id) on delete cascade,
  staff_name      text not null,
  staff_phone     text not null,
  shift_date      date not null,
  status          text not null default 'sent' check (status in ('sent','pending','confirmed','declined')),
  language        text not null default 'en' check (language in ('en','es')),
  sent_at         timestamptz,
  responded_at    timestamptz,
  sms_sent        boolean not null default false,
  sms_error       text,
  created_at      timestamptz not null default now()
);

create index shift_confirmations_property_date_idx on shift_confirmations (property_id, shift_date);
create index shift_confirmations_staff_date_idx on shift_confirmations (staff_id, shift_date);

-- ═══════════════════════════════════════════════════════════════════════════
-- 16. MANAGER NOTIFICATIONS
-- Replaces: properties/{pid}/managerNotifications
-- ═══════════════════════════════════════════════════════════════════════════
create table manager_notifications (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references properties(id) on delete cascade,
  type               text not null check (type in ('decline','no_response','all_confirmed','replacement_found','no_replacement')),
  message            text not null,
  staff_name         text,
  replacement_name   text,
  shift_date         date not null,
  read               boolean not null default false,
  created_at         timestamptz not null default now()
);

create index manager_notifications_property_created_idx on manager_notifications (property_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 17. DEEP CLEAN CONFIG
-- Replaces: properties/{pid}/config/deepClean (single-doc config)
-- One row per property.
-- ═══════════════════════════════════════════════════════════════════════════
create table deep_clean_config (
  property_id         uuid primary key references properties(id) on delete cascade,
  frequency_days      integer not null default 90,
  minutes_per_room    integer not null default 60,
  target_per_week     integer not null default 5,
  updated_at          timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 18. DEEP CLEAN RECORDS
-- Replaces: properties/{pid}/deepCleanRecords
-- ═══════════════════════════════════════════════════════════════════════════
create table deep_clean_records (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  room_number           text not null,
  last_deep_clean       date not null,
  cleaned_by            text,
  cleaned_by_team       text[] default '{}',
  notes                 text,
  status                text check (status in ('in_progress','completed')),
  assigned_at           date,
  completed_at          date,
  updated_at            timestamptz not null default now(),
  unique (property_id, room_number)
);

create index deep_clean_records_property_idx on deep_clean_records (property_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 19. PLAN SNAPSHOTS (CSV scraper output)
-- Replaces: properties/{pid}/planSnapshots/{date}
-- One row per (property, date). Incrementally updated by the CSV scraper.
-- ═══════════════════════════════════════════════════════════════════════════
create table plan_snapshots (
  property_id                       uuid not null references properties(id) on delete cascade,
  date                              date not null,
  pulled_at                         timestamptz not null default now(),
  pull_type                         text not null check (pull_type in ('morning','evening')),
  total_rooms                       integer not null default 0,
  checkouts                         integer not null default 0,
  stayovers                         integer not null default 0,
  stayover_day1                     integer not null default 0,
  stayover_day2                     integer not null default 0,
  stayover_arrival_day              integer not null default 0,
  stayover_unknown                  integer not null default 0,
  arrivals                          integer not null default 0,
  vacant_clean                      integer not null default 0,
  vacant_dirty                      integer not null default 0,
  ooo                               integer not null default 0,
  checkout_minutes                  integer not null default 0,
  stayover_day1_minutes             integer not null default 0,
  stayover_day2_minutes             integer not null default 0,
  vacant_dirty_minutes              integer not null default 0,
  total_cleaning_minutes            integer not null default 0,
  recommended_hks                   numeric not null default 0,
  checkout_room_numbers             text[] not null default '{}',
  stayover_day1_room_numbers        text[] not null default '{}',
  stayover_day2_room_numbers        text[] not null default '{}',
  stayover_arrival_room_numbers     text[] not null default '{}',
  arrival_room_numbers              text[] not null default '{}',
  vacant_clean_room_numbers         text[] not null default '{}',
  vacant_dirty_room_numbers         text[] not null default '{}',
  ooo_room_numbers                  text[] not null default '{}',
  rooms                             jsonb not null default '[]'::jsonb,
  primary key (property_id, date)
);

create index plan_snapshots_property_pulled_idx on plan_snapshots (property_id, pulled_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 20. SCHEDULE ASSIGNMENTS (Maria's HK→room map, survives CSV overwrites)
-- Replaces: properties/{pid}/scheduleAssignments/{date}
-- ═══════════════════════════════════════════════════════════════════════════
create table schedule_assignments (
  property_id          uuid not null references properties(id) on delete cascade,
  date                 date not null,
  room_assignments     jsonb not null default '{}'::jsonb,      -- roomId → staffId map
  crew                 uuid[] not null default '{}',            -- staff IDs on the shift
  staff_names          jsonb not null default '{}'::jsonb,      -- roomId → staffName snapshot
  csv_room_snapshot    jsonb default '[]'::jsonb,               -- last CSV room list seen
  csv_pulled_at        timestamptz,
  updated_at           timestamptz not null default now(),
  primary key (property_id, date)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 21. SCRAPER STATUS (global — single property deploy, shared)
-- Replaces: scraperStatus/{heartbeat|dashboard|vercelWatchdog}
-- Three rows keyed by 'key'.
-- ═══════════════════════════════════════════════════════════════════════════
create table scraper_status (
  key             text primary key,          -- 'heartbeat' | 'dashboard' | 'vercel_watchdog'
  data            jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

-- Seed the three keys so code never has to upsert branch.
insert into scraper_status (key, data) values
  ('heartbeat',       '{}'::jsonb),
  ('dashboard',       '{}'::jsonb),
  ('vercel_watchdog', '{}'::jsonb)
on conflict (key) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 22. DASHBOARD BY DATE (frozen daily snapshots)
-- Replaces: dashboardByDate/{YYYY-MM-DD}
-- ═══════════════════════════════════════════════════════════════════════════
create table dashboard_by_date (
  date                 date primary key,
  in_house             integer,
  arrivals             integer,
  departures           integer,
  in_house_guests      integer,
  arrivals_guests      integer,
  departures_guests    integer,
  pulled_at            timestamptz,
  error_code           text,
  error_message        text,
  error_page           text,
  errored_at           timestamptz
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 23. ERROR LOGS (application error capture)
-- Replaces: errorLogs
-- ═══════════════════════════════════════════════════════════════════════════
create table error_logs (
  id              uuid primary key default gen_random_uuid(),
  ts              timestamptz not null default now(),
  source          text,
  message         text,
  stack           text,
  context         jsonb,
  property_id     uuid references properties(id) on delete set null
);

create index error_logs_ts_idx on error_logs (ts desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 24. WEBHOOK LOG (Twilio SMS inbound)
-- Replaces: webhookLog
-- ═══════════════════════════════════════════════════════════════════════════
create table webhook_log (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  source      text,                             -- 'twilio-sms-reply' etc.
  payload     jsonb not null default '{}'::jsonb
);

create index webhook_log_ts_idx on webhook_log (ts desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIGGERS — keep updated_at fresh on mutation
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

create trigger properties_touch             before update on properties             for each row execute function touch_updated_at();
create trigger accounts_touch               before update on accounts               for each row execute function touch_updated_at();
create trigger staff_touch                  before update on staff                  for each row execute function touch_updated_at();
create trigger rooms_touch                  before update on rooms                  for each row execute function touch_updated_at();
create trigger daily_logs_touch             before update on daily_logs             for each row execute function touch_updated_at();
create trigger work_orders_touch            before update on work_orders            for each row execute function touch_updated_at();
create trigger inspections_touch            before update on inspections            for each row execute function touch_updated_at();
create trigger inventory_touch              before update on inventory              for each row execute function touch_updated_at();
create trigger deep_clean_config_touch      before update on deep_clean_config      for each row execute function touch_updated_at();
create trigger deep_clean_records_touch     before update on deep_clean_records     for each row execute function touch_updated_at();
create trigger schedule_assignments_touch   before update on schedule_assignments   for each row execute function touch_updated_at();
create trigger scraper_status_touch         before update on scraper_status         for each row execute function touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Principle: a row is visible iff its property_id belongs to a property the
-- authenticated user owns (properties.owner_id = auth.uid()). Service-role
-- keys bypass RLS entirely, so the scraper, crons, and admin API routes
-- still work.
-- ═══════════════════════════════════════════════════════════════════════════
alter table properties             enable row level security;
alter table accounts               enable row level security;
alter table staff                  enable row level security;
alter table rooms                  enable row level security;
alter table public_areas           enable row level security;
alter table laundry_config         enable row level security;
alter table daily_logs             enable row level security;
alter table work_orders            enable row level security;
alter table preventive_tasks       enable row level security;
alter table landscaping_tasks      enable row level security;
alter table inventory              enable row level security;
alter table inspections            enable row level security;
alter table handoff_logs           enable row level security;
alter table guest_requests         enable row level security;
alter table shift_confirmations    enable row level security;
alter table manager_notifications  enable row level security;
alter table deep_clean_config      enable row level security;
alter table deep_clean_records     enable row level security;
alter table plan_snapshots         enable row level security;
alter table schedule_assignments   enable row level security;
alter table scraper_status         enable row level security;
alter table dashboard_by_date      enable row level security;
alter table error_logs             enable row level security;
alter table webhook_log            enable row level security;

-- Helper: does the caller own the given property?
create or replace function user_owns_property(p_id uuid) returns boolean as $$
  select exists (
    select 1 from properties
    where id = p_id and owner_id = auth.uid()
  );
$$ language sql stable security definer;

-- ───  POLICIES  ────────────────────────────────────────────────────────────
-- 1. Properties — owner only
create policy "owner can read properties"   on properties for select using (owner_id = auth.uid());
create policy "owner can insert properties" on properties for insert with check (owner_id = auth.uid());
create policy "owner can update properties" on properties for update using (owner_id = auth.uid());
create policy "owner can delete properties" on properties for delete using (owner_id = auth.uid());

-- 2. Accounts — only service role (via admin API) touches this; no anon policies.
--    (RLS is on; no policies = deny all for anon/authenticated.)

-- 3. Per-property tables — read/write iff caller owns the property
-- Macro-like helper via DO block would be tidier, but explicit is clearer for audits.
create policy "owner rw staff"                on staff                for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw rooms"                on rooms                for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw public_areas"         on public_areas         for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw laundry_config"       on laundry_config       for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw daily_logs"           on daily_logs           for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw work_orders"          on work_orders          for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw preventive_tasks"     on preventive_tasks     for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw landscaping_tasks"    on landscaping_tasks    for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw inventory"            on inventory            for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw inspections"          on inspections          for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw handoff_logs"         on handoff_logs         for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw guest_requests"       on guest_requests       for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw shift_confirmations"  on shift_confirmations  for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw manager_notifications" on manager_notifications for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw deep_clean_config"    on deep_clean_config    for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw deep_clean_records"   on deep_clean_records   for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw plan_snapshots"       on plan_snapshots       for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));
create policy "owner rw schedule_assignments" on schedule_assignments for all using (user_owns_property(property_id)) with check (user_owns_property(property_id));

-- 4. Global tables — read-only for any authenticated user (status/dashboard),
--    write only via service role.
create policy "authenticated can read scraper_status"    on scraper_status    for select using (auth.role() = 'authenticated');
create policy "authenticated can read dashboard_by_date" on dashboard_by_date for select using (auth.role() = 'authenticated');

-- 5. Logs — no anon access; service-role only (RLS on + no policies = deny).

-- ═══════════════════════════════════════════════════════════════════════════
-- REALTIME
-- Enable postgres_changes publication on the tables the app subscribes to
-- with onSnapshot-equivalents. Supabase creates this publication for us,
-- we just add the relevant tables.
-- ═══════════════════════════════════════════════════════════════════════════
-- (Run separately after this migration, in supabase/migrations/0002_realtime.sql
--  or via the Supabase dashboard → Database → Replication.)
